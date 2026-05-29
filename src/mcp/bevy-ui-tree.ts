/**
 * Bevy UI Component Tree Extractor
 *
 * Parses Bevy UI spawn code to extract a structured component tree,
 * then renders it as a compact markdown tree for agent consumption.
 *
 * Supports three Bevy spawn patterns:
 *   1. `.spawn((Node{...}, ...))` — tuple bundle (most common)
 *   2. `children![...]` macro — declarative children
 *   3. `Children::spawn(...)` — programmatic spawn
 *
 * Also handles `.with_children(|parent| { ... })` nested closures
 * and cross-function references (→ fn_name @ :line).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node as CGNode, Subgraph, TaskContext, CodeBlock } from '../types';
import { validatePathWithinRoot } from '../utils';

// ============================================================================
// Types
// ============================================================================

interface SpawnTree {
  components: string[];
  propsSummary: string;
  children: SpawnTree[];
  crossRefs: string[];
  forLoop?: string;
}

// ============================================================================
// Bracket matching
// ============================================================================

/**
 * Find the matching closing bracket starting from `openIdx` (which points at
 * the opening bracket character).  Returns the index of the matching close,
 * or -1 on mismatch / EOF.
 */
export function matchBracket(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let escaped = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inStr) {
      if (ch === strCh) inStr = false;
      continue;
    }

    // Skip raw strings: r"..." or r#"..."#  (r##"..."## etc.)
    if (ch === 'r') {
      let hashCount = 0;
      let j = i + 1;
      while (j < text.length && text[j] === '#') { hashCount++; j++; }
      if (j < text.length && text[j] === '"' && hashCount > 0) {
        const closePattern = '"' + '#'.repeat(hashCount);
        const closeIdx = text.indexOf(closePattern, j + 1);
        i = closeIdx >= 0 ? closeIdx + hashCount : text.length - 1;
        continue;
      }
    }

    if (ch === '"' || ch === '\'') {
      inStr = true;
      strCh = ch;
      continue;
    }

    // Skip block comments
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      const endComment = text.indexOf('*/', i + 2);
      i = endComment >= 0 ? endComment + 1 : text.length - 1;
      continue;
    }

    // Skip line comments
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length - 1 : nl;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ============================================================================
// Low-level extractors
// ============================================================================

/** Extract text between matched brackets, excluding the brackets themselves. */
function extractBracketContent(text: string, openIdx: number, open: string, close: string): string | null {
  const closeIdx = matchBracket(text, openIdx, open, close);
  if (closeIdx < 0) return null;
  return text.slice(openIdx + 1, closeIdx);
}

/** Find `..default()` or `..Default::default()` and strip it from struct text. */
function stripRestSyntax(text: string): string {
  return text.replace(/\.\.\s*(?:default\s*\(\s*\)|Default::default\s*\(\s*\))/g, '');
}

/**
 * Find the brace-delimited body of a struct literal starting at `nameIdx`.
 * Skips past `Name` and optional generics `<...>` to the opening `{`.
 */
function extractStructBody(text: string, nameIdx: number): string | null {
  let i = nameIdx;
  // Skip the struct name (letters, digits, underscores, colons for paths)
  while (i < text.length && /[\w:]/.test(text[i]!)) i++;
  // Skip whitespace
  while (i < text.length && /\s/.test(text[i]!)) i++;
  // Skip optional generics
  if (i < text.length && text[i] === '<') {
    const genEnd = matchBracket(text, i, '<', '>');
    if (genEnd < 0) return null;
    i = genEnd + 1;
    while (i < text.length && /\s/.test(text[i]!)) i++;
  }
  if (i >= text.length || text[i] !== '{') return null;
  const body = extractBracketContent(text, i, '{', '}');
  return body ? stripRestSyntax(body) : null;
}

// ============================================================================
// Node property extraction
// ============================================================================

/** Single-pass field extractor — reads `fieldName: value` from struct body text. */
function extractField(body: string, field: string): string | null {
  // Look for `field:` preceded by word-boundary (or start)
  const pattern = new RegExp(`(?:^|[\\s,({])${field}\\s*:\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const start = m.index + m[0].length;
    // Check if this is inside a nested struct (e.g., TextFont { font_size: ... })
    // by looking backwards for an unmatched `{`
    const before = body.slice(0, m.index + m[0].length - field.length - 1);
    const openBraces = (before.match(/{/g) || []).length;
    const closeBraces = (before.match(/}/g) || []).length;
    if (openBraces > closeBraces) continue; // inside nested struct

    // Read value until comma at same brace depth, or `}` at depth 0
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let j = start;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (inStr) { if (c === strCh) inStr = false; continue; }
      if (c === '"' || c === '\'') { inStr = true; strCh = c; continue; }
      if (c === '(' || c === '{') depth++;
      if (c === ')' || c === '}') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) break;
    }
    return body.slice(start, j).trim();
  }
  return null;
}

/** Parse a Rust value expression into a display string. */
function parseRustValue(val: string): string | null {
  if (!val) return null;
  val = val.trim();

  // Enum variant with payload: FlexDirection::Column, Val::Px(100.0), etc.
  const enumMatch = val.match(/^[\w:]+::(\w+)(?:\((.+)\))?$/s);
  if (enumMatch) {
    const variant = enumMatch[1]!;
    const inner = enumMatch[2]?.trim();
    if (inner && /^(?:\d+(?:\.\d+)?)/.test(inner)) {
      return `${variant}(${inner})`;
    }
    return variant;
  }

  // Constructor: px(100), percent(50), Val::Px(100.0)
  const ctorMatch = val.match(/^([\w:]*)\s*\((.+)\)$/s);
  if (ctorMatch) {
    const name = ctorMatch[1]!.split('::').pop()!;
    const inner = ctorMatch[2]!.trim();
    if (name.toLowerCase() === 'px' && /^\d/.test(inner)) return `${inner}px`;
    if (name.toLowerCase() === 'percent' && /^\d/.test(inner)) return `${inner}%`;
    return `${name}(${inner})`;
  }

  // Number literal
  if (/^\d+(?:\.\d+)?$/.test(val)) return val;

  // Constant reference: WIDTH, PADDING, etc.
  if (/^[A-Z][A-Z0-9_]+$/.test(val)) return val;

  // Complex expression (e.g., 文本配置.正文_字号) — return as-is, truncated
  if (val.length <= 30) return val;
  return val.slice(0, 27) + '...';
}

/** Extract key Node { ... } layout properties into a compact summary string. */
export function extractNodeProps(body: string): string {
  const parts: string[] = [];

  const flexDir = extractField(body, 'flex_direction');
  if (flexDir) {
    const v = parseRustValue(flexDir);
    if (v) parts.push(v);
  }

  const width = extractField(body, 'width');
  const height = extractField(body, 'height');
  const w = width ? parseRustValue(width) : null;
  const h = height ? parseRustValue(height) : null;
  if (w || h) {
    parts.push(w && h ? `${w}x${h}` : w || h || '');
  }

  const justify = extractField(body, 'justify_content');
  if (justify) {
    const v = parseRustValue(justify);
    if (v) parts.push(v.toLowerCase());
  }

  const align = extractField(body, 'align_items');
  if (align) {
    const v = parseRustValue(align);
    if (v) parts.push(v.toLowerCase());
  }

  const rowGap = extractField(body, 'row_gap');
  if (rowGap) {
    const v = parseRustValue(rowGap);
    if (v) parts.push(`row-gap:${v}`);
  }

  const colGap = extractField(body, 'column_gap');
  if (colGap) {
    const v = parseRustValue(colGap);
    if (v) parts.push(`col-gap:${v}`);
  }

  const padding = extractField(body, 'padding');
  if (padding) {
    const v = parseRustValue(padding);
    if (v) parts.push(`pad:${v}`);
  }

  const position = extractField(body, 'position_type');
  if (position) {
    const v = parseRustValue(position);
    if (v && v !== 'Relative') parts.push(v);
  }

  const left = extractField(body, 'left');
  const right = extractField(body, 'right');
  const top = extractField(body, 'top');
  const bottom = extractField(body, 'bottom');
  const insetParts: string[] = [];
  if (left) { const v = parseRustValue(left); if (v) insetParts.push(`l:${v}`); }
  if (right) { const v = parseRustValue(right); if (v) insetParts.push(`r:${v}`); }
  if (top) { const v = parseRustValue(top); if (v) insetParts.push(`t:${v}`); }
  if (bottom) { const v = parseRustValue(bottom); if (v) insetParts.push(`b:${v}`); }
  parts.push(...insetParts);

  const border = extractField(body, 'border');
  if (border) {
    const v = parseRustValue(border);
    if (v) parts.push(`border:${v}`);
  }

  const borderRadius = extractField(body, 'border_radius');
  if (borderRadius) {
    const v = parseRustValue(borderRadius);
    if (v) parts.push(`radius:${v}`);
  }

  return parts.join(', ');
}

// ============================================================================
// Component extraction
// ============================================================================

/** Check if spawn text contains any UI component markers. */
export function hasUIComponents(text: string): boolean {
  // Use word-boundary regex for short markers that are substrings of common identifiers
  if (/(?:^|[(,\s])Node(?:\s|{|$)/.test(text)) return true;
  if (/(?:^|[(,\s])Text::/.test(text) || /(?:^|[(,\s])Text\s*\(/.test(text)) return true;
  if (/\bButton\b/.test(text) && !text.includes('MouseButton')) return true;
  // Remaining markers are unique enough for substring matching
  return ['BackgroundColor', 'DespawnOnExit', 'TextFont', 'TextColor', 'Interaction', 'Outline']
    .some(m => text.includes(m));
}

/** Extract component names and notable features from a spawn tuple. */
export function extractComponents(text: string): string[] {
  const result: string[] = [];

  // Node — extract layout props
  const nodeIdx = text.indexOf('Node');
  if (nodeIdx >= 0 && (nodeIdx === 0 || !/\w/.test(text[nodeIdx - 1]!))) {
    const body = extractStructBody(text, nodeIdx);
    if (body) {
      const props = extractNodeProps(body);
      result.push(props ? `Node [${props}]` : 'Node');
    } else {
      result.push('Node');
    }
  }

  // BackgroundColor
  if (text.includes('BackgroundColor')) {
    result.push('BackgroundColor');
  }

  // DespawnOnExit(state)
  const despawnMatch = text.match(/DespawnOnExit\s*\(([^)]+)\)/);
  if (despawnMatch) {
    result.push(`DespawnOnExit(${despawnMatch[1]!.trim()})`);
  }

  // Button (standalone)
  if (/\bButton\b/.test(text) && !text.includes('MouseButton')) {
    result.push('Button');
  }

  // Interaction
  if (text.includes('Interaction')) {
    result.push('Interaction');
  }

  // TextFont — extract font_size if present
  const textFontIdx = text.indexOf('TextFont');
  if (textFontIdx >= 0) {
    const fontBody = extractStructBody(text, textFontIdx);
    if (fontBody) {
      const fontSize = extractField(fontBody, 'font_size');
      if (fontSize) {
        const parsed = parseRustValue(fontSize);
        result.push(`TextFont[${parsed || fontSize}]`);
      } else {
        result.push('TextFont');
      }
    } else {
      result.push('TextFont');
    }
  }

  // TextColor
  if (text.includes('TextColor')) {
    result.push('TextColor');
  }

  // Text::new("content")
  const textNewMatch = text.match(/Text::new\s*\(\s*"([^"]*)"/s);
  if (textNewMatch) {
    result.push(`Text("${textNewMatch[1]}")`);
  }
  // Text(content_var) — non-string arg
  const textVarMatch = text.match(/(?<![a-zA-Z_])Text\s*\(\s*(\w[\w.]*)\s*\)/);
  if (textVarMatch && !textNewMatch) {
    result.push(`Text(${textVarMatch[1]})`);
  }

  // Custom component structs — any remaining CamelCase or snake_case identifier
  // followed by `(` or `{` that isn't a known Bevy type.
  // NOTE: Only CJK-suffixed custom components are detected (`_组件`/`_标记`/`_资源`).
  // English-named custom components (e.g. `PlayerHealth { ... }`) cannot be reliably
  // distinguished from Bevy built-in types without type information — CamelCase heuristics
  // produce false positives on `Handle`, `Source`, `Color`, etc.
  const BEVY_TYPES = new Set([
    'Node', 'Text', 'BackgroundColor', 'Button', 'DespawnOnExit',
    'TextFont', 'TextColor', 'Interaction', 'Outline', 'BorderColor',
    'BorderRadius', 'UiRect', 'Val', 'FlexDirection', 'JustifyContent',
    'AlignItems', 'PositionType', 'Overflow', 'Display', 'Style',
    'FocusPolicy', 'ZIndex', 'GridPlacement', 'UiImage',
    'FontSource', 'FontSize', 'default',
  ]);
  const customMatch = text.match(/(?:^|[(,])\s*([\p{L}][\p{L}\p{N}_]*(?:_组件|_标记|_资源))/gu);
  if (customMatch) {
    for (const m of customMatch) {
      const name = m.replace(/^[^a-zA-Z_\p{L}]+/u, '').trim();
      if (name && !BEVY_TYPES.has(name) && !result.some(r => r.startsWith(name))) {
        result.push(`[${name}]`);
      }
    }
  }

  return result;
}

// ============================================================================
// For-loop detection
// ============================================================================

/**
 * Detect `for (item, label) in [(Enum::Variant, "label"), ...]` patterns
 * inside with_children bodies and extract a compact summary.
 */
function detectForLoop(body: string): string | null {
  const forMatch = body.match(
    /for\s+(?:\([^)]+\)|\w+)\s+in\s*\[([^\]]+)\]/,
  );
  if (!forMatch) return null;

  const items = forMatch[1]!;
  // Try to extract string labels: ("画面"), ("文本"), ...
  const labels = [...items.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  if (labels.length >= 2) {
    return `for [${labels.join(', ')}]`;
  }

  // Try enum variants: 设置标签页::画面, 设置标签页::文本, ...
  const variants = [...items.matchAll(/::(\w+)\b/g)].map(m => m[1]);
  if (variants.length >= 2) {
    return `for [${variants.join(', ')}]`;
  }

  return null;
}

// ============================================================================
// with_children / children![] extraction
// ============================================================================

/** Find `children![...]` macro invocations and extract their content. */
function findChildrenMacroBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /children!\s*\[/g;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    const content = extractBracketContent(text, m.index + m[0].length - 1, '[', ']');
    if (content) blocks.push(content);
  }

  return blocks;
}

// ============================================================================
// Cross-function reference detection
// ============================================================================

/**
 * Find function calls in spawn body that match known symbols in the subgraph.
 * Returns formatted strings like "→ fn_name @ :line".
 */
function findCrossRefs(
  text: string,
  nodesByName: Map<string, CGNode>,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();

  // Match identifier( patterns that could be function calls
  // Exclude Rust keywords and known Bevy types
  const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'match', 'return', 'let', 'mut',
    'fn', 'struct', 'enum', 'impl', 'pub', 'use', 'mod', 'self',
    'super', 'crate', 'move', 'ref', 'async', 'await',
  ]);
  const callPattern = /(?<![\p{L}\p{N}_])([\p{L}\p{N}_][\p{L}\p{N}_]*)\s*\(/gu;
  let cm: RegExpExecArray | null;

  while ((cm = callPattern.exec(text)) !== null) {
    const name = cm[1]!;
    if (KEYWORDS.has(name)) continue;
    if (seen.has(name)) continue;

    // Check if this function exists in the subgraph
    const node = nodesByName.get(name);
    if (node && (node.kind === 'function' || node.kind === 'method')) {
      seen.add(name);
      const loc = node.filePath ? `:${node.startLine}` : '';
      refs.push(`→ ${name} @ ${path.basename(node.filePath)}${loc}`);
    }
  }

  return refs;
}

// ============================================================================
// Spawn tree extraction (core)
// ============================================================================

/**
 * Search for `.with_children(|...| {` starting after `afterIdx`.
 * If found, extract the closure body with matchBracket and return it along with
 * the end index of the closing brace. Returns null if no `.with_children` follows.
 */
function findWithChildrenBody(text: string, afterIdx: number): { body: string; endIdx: number } | null {
  const wcPattern = /\.with_children\s*\(\s*\|/g;
  wcPattern.lastIndex = afterIdx;
  const wcMatch = wcPattern.exec(text);
  if (!wcMatch) return null;

  // Find the opening { of the closure body (after the |...| params)
  let i = wcMatch.index + wcMatch[0].length;
  while (i < text.length && text[i] !== '|') i++; // skip closure params
  if (i >= text.length) return null;
  i++; // skip closing |
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (i >= text.length || text[i] !== '{') return null;

  const closeIdx = matchBracket(text, i, '{', '}');
  if (closeIdx < 0) return null;
  return { body: text.slice(i + 1, closeIdx), endIdx: closeIdx };
}

/** Recursively extract spawn trees from text. */
export function extractSpawnTrees(
  text: string,
  nodesByName: Map<string, CGNode>,
  depth: number,
): SpawnTree[] {
  if (depth > 10) return []; // guard against infinite recursion
  const trees: SpawnTree[] = [];

  // --- Pattern 1: `.spawn((` or `.spawn(` ---
  const spawnPattern = /\.spawn\s*\(\s*(\(?)/g;
  let m: RegExpExecArray | null;

  while ((m = spawnPattern.exec(text)) !== null) {
    const hasDouble = m[1] === '(';
    const argStart = m.index + m[0].length - (hasDouble ? 1 : 0);
    const openCh = hasDouble ? '(' : text[argStart];
    const closeCh = openCh === '(' ? ')' : openCh === '{' ? '}' : ')';

    if (!openCh || (openCh !== '(' && openCh !== '{')) continue;

    const content = extractBracketContent(text, argStart, openCh, closeCh);
    if (!content) continue;
    if (!hasUIComponents(content)) continue;

    const components = extractComponents(content);
    const nodeBody = extractStructBody(content, content.indexOf('Node'));
    const propsSummary = nodeBody ? extractNodeProps(nodeBody) : '';

    // Look for children in `.with_children` chained after this spawn
    const spawnEnd = matchBracket(text, argStart, openCh, closeCh);
    if (spawnEnd < 0) continue;

    // Find the with_children closure body (if any) — limits recursion to this spawn's children only
    const wcBody = findWithChildrenBody(text, spawnEnd + 1);
    const children: SpawnTree[] = [];
    let forLoop: string | null = null;

    if (wcBody) {
      children.push(...extractSpawnTrees(wcBody.body, nodesByName, depth + 1));
      forLoop = detectForLoop(wcBody.body);
    }

    const crossRefs = findCrossRefs(content, nodesByName);

    trees.push({ components, propsSummary, children, crossRefs, forLoop: forLoop ?? undefined });

    // Advance lastIndex past the with_children body (or spawn args) to skip sibling spawns
    spawnPattern.lastIndex = wcBody ? wcBody.endIdx + 1 : spawnEnd + 1;
  }

  // --- Pattern 2: `children![...]` ---
  const childrenBlocks = findChildrenMacroBlocks(text);
  for (const block of childrenBlocks) {
    // Split on balanced commas to find individual child elements
    const elements = splitBalanced(block);
    for (const elem of elements) {
      const trimmed = elem.trim();
      if (!trimmed || trimmed === ',') continue;
      if (!hasUIComponents(trimmed)) continue;

      // Each element is either a tuple `(Node{...}, ...)` or a function call
      const components = extractComponents(trimmed);
      const nodeBody = extractStructBody(trimmed, trimmed.indexOf('Node'));
      const propsSummary = nodeBody ? extractNodeProps(nodeBody) : '';
      const crossRefs = findCrossRefs(trimmed, nodesByName);

      // Recurse into nested children![]
      const nestedChildren = extractSpawnTrees(trimmed, nodesByName, depth + 1);

      trees.push({ components, propsSummary, children: nestedChildren, crossRefs });
    }
  }

  // --- Pattern 3: `Children::spawn(...)` (rare, programmatic) ---
  const csPattern = /Children::spawn\s*\(/g;
  let cs: RegExpExecArray | null;
  while ((cs = csPattern.exec(text)) !== null) {
    const content = extractBracketContent(text, cs.index + cs[0].length - 1, '(', ')');
    if (!content) continue;
    if (!hasUIComponents(content)) continue;

    const components = extractComponents(content);
    const crossRefs = findCrossRefs(content, nodesByName);
    trees.push({ components, propsSummary: '', children: [], crossRefs });
  }

  return trees;
}

/**
 * Split text on top-level commas (respecting bracket depth).
 */
function splitBalanced(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inStr = false;
  let strCh = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      current += ch;
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inStr = true;
      strCh = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// ============================================================================
// UI symbol detection
// ============================================================================

/** Keywords that indicate a UI spawn function. */
const UI_SPAWN_KEYWORDS = [
  'commands.spawn', 'with_children', 'children!',
  'Node {', 'Text::new', 'BackgroundColor', 'DespawnOnExit',
];

/**
 * Read the source code for a node from its file.
 */
function readNodeSource(projectRoot: string, node: CGNode): string | null {
  const filePath = validatePathWithinRoot(projectRoot, node.filePath);
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, node.startLine - 1);
    const end = Math.min(lines.length, node.endLine);
    return lines.slice(start, end).join('\n');
  } catch {
    return null;
  }
}

/** Check if a source snippet contains UI spawn patterns. */
function sourceContainsUISpawn(source: string): boolean {
  return UI_SPAWN_KEYWORDS.some(kw => source.includes(kw));
}

/**
 * Find systems registered to UI-related entry points.
 * Returns a formatted string listing system name, schedule, and location.
 */
export function findRegisteredSystems(
  entryNode: CGNode,
  subgraph: Subgraph,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const edge of subgraph.edges) {
    // Edge FROM this entry point TO a system registration
    if (edge.source !== entryNode.id) continue;
    const K = edge.kind;
    if (K !== 'registers_system' && K !== 'runs_in' && K !== 'on_enter' && K !== 'on_exit' && K !== 'on_transition') continue;

    const targetNode = subgraph.nodes.get(edge.target);
    if (!targetNode || seen.has(targetNode.id)) continue;
    seen.add(targetNode.id);

    const meta = edge.metadata as Record<string, unknown> | undefined;
    const schedule = meta?.schedule ? String(meta.schedule) : '';
    const state = meta?.state ? String(meta.state) : '';

    let scheduleLabel = '';
    if (schedule.includes('OnEnter')) {
      const st = schedule.match(/OnEnter\s*\(([^)]+)\)/)?.[1] || state;
      scheduleLabel = st ? `OnEnter(${st})` : 'OnEnter';
    } else if (schedule.includes('OnExit')) {
      const st = schedule.match(/OnExit\s*\(([^)]+)\)/)?.[1] || state;
      scheduleLabel = st ? `OnExit(${st})` : 'OnExit';
    } else if (schedule.includes('Update')) {
      scheduleLabel = 'Update';
    } else if (schedule) {
      scheduleLabel = schedule;
    }

    const loc = targetNode.filePath ? `@ ${path.basename(targetNode.filePath)}:${targetNode.startLine}` : '';
    const parts = [targetNode.name];
    if (scheduleLabel) parts.push(`(${scheduleLabel})`);
    if (loc) parts.push(loc);
    lines.push(parts.join(' '));
  }

  return lines;
}

// ============================================================================
// Tree rendering
// ============================================================================

const TREE_BRANCH = '├── ';
const TREE_LAST    = '└── ';
const TREE_PIPE    = '│   ';
const TREE_SPACE   = '    ';

/** Render a SpawnTree into markdown tree lines. */
function renderSpawnTree(tree: SpawnTree, prefix: string, isLast: boolean): string[] {
  const lines: string[] = [];
  const connector = isLast ? TREE_LAST : TREE_BRANCH;

  // Build component description
  let desc = tree.components.join(' + ');
  if (tree.forLoop) {
    desc = `${tree.forLoop}: ${desc}`;
  }
  if (tree.propsSummary && !tree.components.some(c => c.startsWith('Node'))) {
    // If there's a Node props summary but it wasn't captured in components
    desc = `[${tree.propsSummary}]` + (desc ? ` ${desc}` : '');
  }

  lines.push(`${prefix}${connector}${desc}`);

  // Cross-function references
  const childPrefix = prefix + (isLast ? TREE_SPACE : TREE_PIPE);
  for (const ref of tree.crossRefs) {
    lines.push(`${childPrefix}├─ ${ref}`);
  }

  // Children
  for (let i = 0; i < tree.children.length; i++) {
    const childLines = renderSpawnTree(
      tree.children[i]!,
      childPrefix,
      i === tree.children.length - 1 && tree.crossRefs.length === 0,
    );
    lines.push(...childLines);
  }

  return lines;
}

// ============================================================================
// Main public API
// ============================================================================

/**
 * Build the UI Structure section for `codegraph_context` output.
 *
 * Returns empty string if no UI spawn code is detected among the context's
 * entry points.
 */
export function buildUITreeSection(
  context: TaskContext,
  projectRoot: string,
): string {
  const { entryPoints, subgraph, codeBlocks } = context;
  if (entryPoints.length === 0) return '';

  // Build lookup maps
  const nodesByName = new Map<string, CGNode>();
  for (const n of subgraph.nodes.values()) {
    if (!nodesByName.has(n.name)) nodesByName.set(n.name, n);
  }
  const codeByNodeId = new Map<string, CodeBlock>();
  for (const cb of codeBlocks) {
    if (cb.node) codeByNodeId.set(cb.node.id, cb);
  }

  // Find UI-related entry points
  const uiEntries: { node: CGNode; source: string }[] = [];

  for (const ep of entryPoints) {
    // Try code block first (already extracted)
    const cb = codeByNodeId.get(ep.id);
    if (cb && sourceContainsUISpawn(cb.content)) {
      uiEntries.push({ node: ep, source: cb.content });
      continue;
    }

    // Read source from file
    const source = readNodeSource(projectRoot, ep);
    if (source && sourceContainsUISpawn(source)) {
      uiEntries.push({ node: ep, source });
      continue;
    }

    // Check registered systems (entry point is a Plugin struct)
    const systems = findRegisteredSystems(ep, subgraph);
    for (const sysLine of systems) {
      const sysName = sysLine.split(' ')[0]!;
      const sysNode = nodesByName.get(sysName);
      if (!sysNode) continue;
      const sysSource = readNodeSource(projectRoot, sysNode);
      if (sysSource && sourceContainsUISpawn(sysSource)) {
        uiEntries.push({ node: sysNode, source: sysSource });
      }
    }
  }

  if (uiEntries.length === 0) return '';

  // Build output
  const lines: string[] = ['', '### UI Structure'];

  // Group by plugin if possible — find the plugin struct name
  const pluginEntry = entryPoints.find(ep => ep.kind === 'struct');
  const pluginName = pluginEntry?.name || '';
  if (pluginName) {
    lines[1] = `### UI Structure — ${pluginName}`;
  }

  // Show registered systems
  const allSystems: string[] = [];
  for (const ep of entryPoints) {
    const systems = findRegisteredSystems(ep, subgraph);
    for (const s of systems) {
      if (!allSystems.includes(s)) allSystems.push(s);
    }
  }
  if (allSystems.length > 0) {
    lines.push(`Systems: ${allSystems.join(', ')}`);
  }
  lines.push('');

  // Render each UI entry's spawn tree
  for (const { node, source } of uiEntries) {
    const trees = extractSpawnTrees(source, nodesByName, 0);
    if (trees.length === 0) continue;

    const loc = node.filePath ? `@ ${path.basename(node.filePath)}:${node.startLine}` : '';
    lines.push(`#### ${node.name} ${loc}`);

    for (let i = 0; i < trees.length; i++) {
      const treeLines = renderSpawnTree(trees[i]!, '', i === trees.length - 1);
      lines.push(...treeLines);
    }
    lines.push('');
  }

  return lines.length > 3 ? '\n' + lines.join('\n') : '';
}
