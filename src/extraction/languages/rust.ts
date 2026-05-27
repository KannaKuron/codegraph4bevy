import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext, PostExtractContext } from '../tree-sitter-types';
import type { UnresolvedReference, NodeKind } from '../../types';

// ── Module-level state (single-threaded extraction, safe) ──────────
let isExtractingPattern = false;

// ── Constants ──────────────────────────────────────────────────────

const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
  'object', 'symbol', 'bigint', 'true', 'false',
  // Rust
  'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
  // Java/C#
  'int', 'long', 'short', 'byte', 'float', 'double', 'char',
  // Go
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
]);

const BEVY_SYSTEM_METHODS = new Set([
  'add_systems', 'observe', 'configure_sets',
]);
const BEVY_INSTANTIATE_METHODS = new Set([
  'add_plugins', 'init_resource', 'add_event', 'insert_resource',
  'init_state', 'add_sub_state', 'register_type',
]);
const BEVY_STATE_FUNCTIONS = new Set([
  'OnEnter', 'OnExit', 'OnTransition', 'in_state',
]);
const BEVY_STATE_CONSTRUCTORS = new Set([
  'DespawnOnExit', 'Pending',
]);

const ADD_SYSTEMS_RE = /\.?(add_systems|add_plugins|observe|configure_sets)\s*\(/;
const IDENT_EXCLUDE_RE = /^(?:Update|FixedUpdate|PreUpdate|PostUpdate|Last|Startup|First|PreStartup|FixedPreUpdate|FixedPostUpdate|FixedFirst|FixedLast|RunOnce|PostStartup|OnEnter|OnExit|OnTransition|in_state|resource_exists|run_if|after|before|chain|pipe|and_then|or_else|map|filter|let|mut|use|fn|pub|impl|for|self|app|Res|ResMut|Commands|Query|EventWriter|EventReader|MessageWriter|MessageReader|Local|NextState|DespawnOnExit|ParamSet|NonSend|NonSendMut|Gizmos|Single|Populated|with_child|entity|commands)$/;
const SYSTEM_IDENT_RE = /(?:^|[,\s(]+)([\w一-鿿][\w一-鿿]*(?:::(?:[\w一-鿿]+))*)\s*(?=\.\w|[,\\)]|$)/g;

// ── Helpers ────────────────────────────────────────────────────────

function findNodeByName(nodes: readonly { id: string; name: string; kind: string }[], name: string): string | undefined {
  for (const node of nodes) {
    if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
      return node.id;
    }
  }
  return undefined;
}

// ── Pattern extraction ─────────────────────────────────────────────

function extractPatternReferences(
  node: SyntaxNode,
  fromNodeId: string,
  source: string,
  addRef: (ref: UnresolvedReference) => void,
  edgeKind: 'references' | 'pattern_match' = 'pattern_match',
): void {
  if (node.type === 'scoped_identifier') {
    const name = getNodeText(node, source);
    if (name && name.includes('::')) {
      addRef({
        fromNodeId,
        referenceName: name,
        referenceKind: edgeKind,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }
  if (node.type === 'identifier') {
    const name = getNodeText(node, source);
    const firstChar = name ? name[0] : undefined;
    if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !BUILTIN_TYPES.has(name!)) {
      addRef({
        fromNodeId,
        referenceName: name!,
        referenceKind: edgeKind,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) extractPatternReferences(child, fromNodeId, source, addRef, edgeKind);
  }
}

function extractMatchReferences(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  if (nodeStack.length === 0) return;
  const callerId = nodeStack[nodeStack.length - 1];
  if (!callerId) return;

  const arms: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'match_arm') {
      arms.push(child);
    } else if (child.type === 'match_block') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const arm = child.namedChild(j);
        if (arm && arm.type === 'match_arm') {
          arms.push(arm);
        }
      }
    }
  }
  for (const arm of arms) {
    extractPatternReferences(arm, callerId, source, addRef);
  }
}

function extractIfLetReferences(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  if (nodeStack.length === 0) return;
  const callerId = nodeStack[nodeStack.length - 1];
  if (!callerId) return;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'let_condition' || child.type === 'match_pattern') {
      extractPatternReferences(child, callerId, source, addRef);
    } else if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      extractPatternReferences(child, callerId, source, addRef);
    }
  }
}

function extractMatchesMacroReferences(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  if (nodeStack.length === 0) return;
  const callerId = nodeStack[nodeStack.length - 1];
  if (!callerId) return;

  let isMatches = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'identifier' || child.type === 'macro_name'
        || child.type === 'scoped_identifier')) {
      const raw = getNodeText(child, source);
      const text = child.type === 'scoped_identifier' ? raw.split('::').pop()! : raw;
      if (text === 'matches') {
        isMatches = true;
        break;
      }
    }
  }
  if (!isMatches) return;

  const tokenTree = node.namedChildren.find(c => c.type === 'token_tree');
  if (!tokenTree || !tokenTree.children) return;
  let seenComma = false;
  for (let i = 0; i < tokenTree.children.length; i++) {
    const child = tokenTree.children[i];
    if (!child) continue;
    if (!seenComma && child.type === ',') { seenComma = true; continue; }
    if (seenComma) {
      extractPatternReferences(child, callerId, source, addRef);
    }
  }
}

function extractMacroCall(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  if (nodeStack.length === 0) return;
  const callerId = nodeStack[nodeStack.length - 1];
  if (!callerId) return;

  let macroName = '';
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'identifier' || child.type === 'macro_name'
        || child.type === 'scoped_identifier')) {
      const raw = getNodeText(child, source);
      macroName = child.type === 'scoped_identifier' ? raw.split('::').pop()! : raw;
      break;
    }
  }
  if (!macroName) return;

  addRef({
    fromNodeId: callerId,
    referenceName: macroName,
    referenceKind: 'macro_call',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function extractMacroTokenTreePatterns(node: SyntaxNode, macroNodeId: string, source: string, addRef: (ref: UnresolvedReference) => void): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'scoped_identifier') {
      const name = getNodeText(child, source);
      if (name && name.includes('::')) {
        addRef({
          fromNodeId: macroNodeId,
          referenceName: name,
          referenceKind: 'pattern_match',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }
      continue;
    }

    if (child.type === 'identifier') {
      const name = getNodeText(child, source);
      const firstChar = name ? name[0] : undefined;
      if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !BUILTIN_TYPES.has(name!)) {
        addRef({
          fromNodeId: macroNodeId,
          referenceName: name!,
          referenceKind: 'pattern_match',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }
      continue;
    }

    if (child.type === 'token_tree' || child.type === 'token_tree_pattern' || child.type === 'token_repetition') {
      extractMacroTokenTreePatterns(child, macroNodeId, source, addRef);
    }
  }
}

function extractTokenTreeIdentRefs(node: SyntaxNode, fromNodeId: string, source: string, addRef: (ref: UnresolvedReference) => void): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'scoped_identifier') {
      const name = getNodeText(child, source);
      if (name && name.includes('::')) {
        addRef({
          fromNodeId,
          referenceName: name,
          referenceKind: 'references',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }
      continue;
    }

    if (child.type === 'identifier') {
      const name = getNodeText(child, source);
      const firstChar = name ? name[0] : undefined;
      if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !BUILTIN_TYPES.has(name!)) {
        addRef({
          fromNodeId,
          referenceName: name!,
          referenceKind: 'references',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }
      continue;
    }

    if (child.type === 'token_tree' || child.type === 'token_tree_pattern' || child.type === 'token_repetition') {
      extractTokenTreeIdentRefs(child, fromNodeId, source, addRef);
    }
  }
}

function extractMacroInvocationArgs(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  let isMatches = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'identifier' || child.type === 'macro_name')) {
      if (getNodeText(child, source) === 'matches') {
        isMatches = true;
        break;
      }
    }
  }
  if (isMatches) return;

  const fromNodeId = nodeStack[nodeStack.length - 1];
  if (!fromNodeId || fromNodeId.startsWith('file:')) return;

  const tokenTree = node.namedChildren.find(c => c.type === 'token_tree');
  if (!tokenTree) return;

  extractTokenTreeIdentRefs(tokenTree, fromNodeId, source, addRef);
}

function extractScopedValueReference(node: SyntaxNode, source: string, addRef: (ref: UnresolvedReference) => void, nodeStack: readonly string[]): void {
  const name = getNodeText(node, source);
  if (!name || !name.includes('::')) return;

  const fromNodeId = nodeStack[nodeStack.length - 1];
  if (!fromNodeId) return;
  if (fromNodeId.startsWith('file:')) return;

  addRef({
    fromNodeId,
    referenceName: name,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

// ── Rust impl item ─────────────────────────────────────────────────

function extractRustImplItem(
  node: SyntaxNode,
  source: string,
  nodes: readonly { id: string; name: string; kind: string; signature?: string }[],
  addRef: (ref: UnresolvedReference) => void,
  extractTypeRefs: (node: SyntaxNode, fromNodeId: string, insideTypeArgs?: boolean) => void,
): void {
  const hasFor = node.children.some(
    (c: SyntaxNode) => c.type === 'for' && !c.isNamed
  );
  if (!hasFor) return;

  const typeIdents = node.namedChildren.filter(
    (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
  );
  if (typeIdents.length < 2) return;

  const traitNode = typeIdents[0]!;
  const typeNode = typeIdents[typeIdents.length - 1]!;

  const traitName = traitNode.type === 'scoped_type_identifier'
    ? source.substring(traitNode.startIndex, traitNode.endIndex)
    : getNodeText(traitNode, source);

  let typeName: string;
  if (typeNode.type === 'generic_type') {
    const inner = typeNode.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_identifier'
    );
    typeName = inner ? getNodeText(inner, source) : getNodeText(typeNode, source);
  } else {
    typeName = getNodeText(typeNode, source);
  }

  const typeNodeId = findNodeByName(nodes, typeName);
  if (typeNodeId) {
    addRef({
      fromNodeId: typeNodeId,
      referenceName: traitName,
      referenceKind: 'implements',
      line: traitNode.startPosition.row + 1,
      column: traitNode.startPosition.column,
    });
    if (typeNode.type === 'generic_type') {
      const typeArgs = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_arguments'
      );
      if (typeArgs) {
        extractTypeRefs(typeArgs, typeNodeId, true);
      }
    }
    const targetNode = nodes.find(n => n.id === typeNodeId) as { signature?: string } | undefined;
    if (targetNode) {
      const existing = targetNode.signature ?? '';
      const implEntry = `implements ${traitName}`;
      targetNode.signature = existing ? `${existing}; ${implEntry}` : implEntry;
    }
  }
}

// ── Bevy call extraction ──────────────────────────────────────────

function extractBevyCallRefs(
  node: SyntaxNode,
  callerId: string,
  calleeName: string,
  source: string,
  addRef: (ref: UnresolvedReference) => void,
): void {
  const lastDot = calleeName.lastIndexOf('.');
  let methodName = lastDot >= 0 ? calleeName.slice(lastDot + 1) : calleeName;
  const turbofish = methodName.indexOf('::<');
  if (turbofish >= 0) methodName = methodName.slice(0, turbofish);

  const isSystemCall = BEVY_SYSTEM_METHODS.has(methodName);
  const isInstantiateCall = BEVY_INSTANTIATE_METHODS.has(methodName);
  const isStateCall = BEVY_STATE_FUNCTIONS.has(calleeName);

  if (!isSystemCall && !isInstantiateCall && !isStateCall) return;

  const edgeKind = isInstantiateCall ? 'instantiates'
    : isStateCall ? 'references'
    : 'calls';

  const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
    c => c.type === 'arguments'
  );
  if (!args) return;

  const startIdx = (methodName === 'add_systems') ? 1 : 0;

  const collectFuncRefs = (child: SyntaxNode, skip: number): void => {
    if (skip > 0) { skip--; return; }
    if (child.type === 'tuple_expression' || child.type === 'token_tree') {
      for (let i = 0; i < child.namedChildCount; i++) {
        const item = child.namedChild(i);
        if (item) collectFuncRefs(item, 0);
      }
      return;
    }
    if (child.type === 'identifier' || child.type === 'scoped_identifier') {
      const name = getNodeText(child, source);
      if (name) {
        addRef({
          fromNodeId: callerId,
          referenceName: name,
          referenceKind: edgeKind,
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
        if (isStateCall && name.includes('::')) {
          const baseName = name.split('::')[0]!;
          addRef({
            fromNodeId: callerId,
            referenceName: baseName,
            referenceKind: 'type_of',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
      }
      return;
    }
    if (child.type === 'field_expression') {
      const value = getChildByField(child, 'value') ?? child.namedChild(0);
      if (value) collectFuncRefs(value, 0);
      return;
    }
  };

  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child) collectFuncRefs(child, startIdx > i ? 1 : 0);
  }
}

function extractBevyNestedRefs(
  node: SyntaxNode,
  callerId: string,
  source: string,
  addRef: (ref: UnresolvedReference) => void,
): void {
  const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
    c => c.type === 'arguments'
  );
  if (!args) return;

  const scanForBevy = (child: SyntaxNode): void => {
    if (child.type === 'call_expression') {
      const func = getChildByField(child, 'function') ?? child.namedChild(0);
      if (func) {
        const name = getNodeText(func, source);
        if (BEVY_STATE_FUNCTIONS.has(name)) {
          extractBevyCallRefs(child, callerId, name, source, addRef);
        } else {
          const methodName = name.split(/[.:]/).pop()!;
          if (BEVY_SYSTEM_METHODS.has(methodName) || BEVY_INSTANTIATE_METHODS.has(methodName)) {
            extractBevyCallRefs(child, callerId, name, source, addRef);
          }
        }
      }
    }
    for (let i = 0; i < child.namedChildCount; i++) {
      const c = child.namedChild(i);
      if (c) scanForBevy(c);
    }
  };

  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child) scanForBevy(child);
  }
}

function extractBevyStateCtorRefs(
  node: SyntaxNode,
  callerId: string,
  calleeName: string,
  source: string,
  addRef: (ref: UnresolvedReference) => void,
): void {
  const leafName = calleeName.includes('::')
    ? calleeName.split('::').pop()!
    : calleeName.includes('.')
      ? calleeName.split('.').pop()!
      : calleeName;

  if (!BEVY_STATE_CONSTRUCTORS.has(leafName)) return;

  const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
    c => c.type === 'arguments'
  );
  if (!args) return;

  const collectScopedBase = (child: SyntaxNode): void => {
    if (child.type === 'scoped_identifier') {
      const name = getNodeText(child, source);
      if (name && name.includes('::')) {
        const baseName = name.split('::')[0]!;
        addRef({
          fromNodeId: callerId,
          referenceName: baseName,
          referenceKind: 'type_of',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }
      return;
    }
    if (child.type === 'tuple_expression' || child.type === 'token_tree') {
      for (let i = 0; i < child.namedChildCount; i++) {
        const item = child.namedChild(i);
        if (item) collectScopedBase(item);
      }
    }
  };

  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child) collectScopedBase(child);
  }
}

// ── Bevy fallback scanner ──────────────────────────────────────────

function scanBevyPatternsFallback(ctx: PostExtractContext): void {
  const existingKeys = new Set<string>();
  for (const ref of ctx.unresolvedReferences) {
    existingKeys.add(`${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}`);
  }

  const source = ctx.source;
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    ADD_SYSTEMS_RE.lastIndex = 0;
    const apiMatch = ADD_SYSTEMS_RE.exec(line);
    if (!apiMatch) continue;

    const apiMethod = apiMatch[1]!;
    const edgeKind: 'calls' | 'instantiates' =
      apiMethod === 'add_plugins' ? 'instantiates' : 'calls';

    let parenDepth = 0;
    let seenScheduleComma = false;
    for (let j = i; j < lines.length; j++) {
      const sl = lines[j]!;

      let lineParenDepth = 0;
      for (let k = 0; k < sl.length; k++) {
        if (sl[k] === '(') { parenDepth++; lineParenDepth++; }
        if (sl[k] === ')') { parenDepth--; lineParenDepth--; }
      }

      if (!seenScheduleComma && parenDepth >= 1) {
        const commaPos = sl.indexOf(',');
        if (commaPos >= 0) {
          let preCommaParens = 0;
          for (let k = 0; k < commaPos; k++) {
            if (sl[k] === '(') preCommaParens++;
            if (sl[k] === ')') preCommaParens--;
          }
          if (preCommaParens <= 1) {
            seenScheduleComma = true;
          }
        }
      }

      if (seenScheduleComma && parenDepth >= 1) {
        const identRe = SYSTEM_IDENT_RE;
        identRe.lastIndex = 0;
        let identMatch;
        while ((identMatch = identRe.exec(sl)) !== null) {
          const name = identMatch[1]!;
          if (IDENT_EXCLUDE_RE.test(name)) continue;

          const callerId = ctx.getCallerByLine(j + 1);
          if (callerId) {
            const key = `${callerId}:${name}:${edgeKind}:${j + 1}`;
            if (!existingKeys.has(key)) {
              existingKeys.add(key);
              ctx.addUnresolvedReference({
                fromNodeId: callerId,
                referenceName: name,
                referenceKind: edgeKind,
                line: j + 1,
                column: identMatch.index + 1,
              });
            }
          }
        }
      }

      if (parenDepth <= 0) break;
    }
  }
}

// ── Attribute type-reference extraction ─────────────────────────────

/**
 * Extract type references from Rust attribute macro arguments.
 * tree-sitter parses `#[source(游戏流程_状态 = 游戏流程_状态::初始化)]` as
 * meta_item nodes, not as type paths, so the normal extraction misses them.
 * This scans for known Bevy attribute patterns and creates references edges.
 */
function scanAttributeTypeRefs(ctx: PostExtractContext): void {
  const source = ctx.source;
  const lines = source.split('\n');

  // Build lookup: startLine → nodeId for ALL non-file nodes
  const nodeByStartLine = new Map<number, string>();
  for (const n of ctx.nodes) {
    if (n.startLine && n.kind !== 'file') {
      nodeByStartLine.set(n.startLine, n.id);
    }
  }

  const existingKeys = new Set<string>();
  for (const ref of ctx.unresolvedReferences) {
    existingKeys.add(`${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}`);
  }

  // Match #[source(TypePath = ValuePath)] — Bevy SubStates source attribute
  // Handles CJK names: 游戏流程_状态, scoped paths: State::Variant
  const IDENT = '[\\p{L}\\p{N}_]+';
  const PATH = `${IDENT}(?:\\s*::\\s*${IDENT})*`;
  const SOURCE_ATTR_RE = new RegExp(
    `#\\[\\s*source\\s*\\(\\s*(${PATH})\\s*=\\s*(${PATH})\\s*\\)\\s*\\]`, 'gu',
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    SOURCE_ATTR_RE.lastIndex = 0;
    const match = SOURCE_ATTR_RE.exec(line);
    if (!match) continue;

    const leftPath = match[1]!.replace(/\s/g, '');
    const rightPath = match[2]!.replace(/\s/g, '');
    const attrLine = i + 1;

    // Find the decorated item: next non-empty, non-attribute, non-comment line
    let decoratedNodeId: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j]!.trim();
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
      decoratedNodeId = nodeByStartLine.get(j + 1);
      break;
    }

    if (!decoratedNodeId) continue;

    for (const path of [leftPath, rightPath]) {
      const key = `${decoratedNodeId}:${path}:references:${attrLine}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        ctx.addUnresolvedReference({
          fromNodeId: decoratedNodeId,
          referenceName: path,
          referenceKind: 'references',
          line: attrLine,
          column: line.indexOf(path.split('::')[0]!) + 1,
        });
      }
    }
  }
}

// ── Rust variable extraction ───────────────────────────────────────

function extractRustVariable(
  node: SyntaxNode,
  ctx: ExtractorContext,
  _nodeType: string,
  kind: NodeKind,
  docstring: string | undefined,
  isExported: boolean | undefined,
): boolean {
  const source = ctx.source;
  const addRef = (ref: UnresolvedReference) => ctx.addUnresolvedReference(ref);

  if (node.type === 'let_declaration') {
    const patternNode = getChildByField(node, 'pattern');
    if (patternNode && patternNode.type === 'identifier') {
      const name = getNodeText(patternNode, source);
      const varNode = ctx.createNode(kind, name, patternNode, { docstring, isExported });
      if (varNode) {
        const typeNode = getChildByField(node, 'type');
        if (typeNode) {
          ctx.extractTypeRefsFromSubtree(typeNode, varNode.id);
        }
        const valueNode = getChildByField(node, 'value');
        if (valueNode) {
          ctx.visitNode(valueNode);
        }
      }
    } else {
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (fromNodeId && !fromNodeId.startsWith('file:')) {
        const typeNode = getChildByField(node, 'type');
        if (typeNode) {
          ctx.extractTypeRefsFromSubtree(typeNode, fromNodeId);
        }
        const valueNode = getChildByField(node, 'value');
        if (valueNode) {
          ctx.visitNode(valueNode);
        }
      }
    }
    return true;
  }

  if (node.type === 'const_item' || node.type === 'static_item') {
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const name = getNodeText(nameNode, source);
      const isConstItem = node.type === 'const_item';
      const itemKind: NodeKind = isConstItem ? 'constant' : 'variable';
      const varNode = ctx.createNode(itemKind, name, nameNode, { docstring, isExported });
      if (varNode) {
        const typeNode = getChildByField(node, 'type');
        if (typeNode) {
          ctx.extractTypeRefsFromSubtree(typeNode, varNode.id);
        }
        const valueNode = getChildByField(node, 'value') ?? getChildByField(node, 'body');
        if (valueNode) {
          extractPatternReferences(valueNode, varNode.id, source, addRef, 'references');
        }
      }
    }
    return true;
  }

  return false;
}

// ── visitNode helpers ──────────────────────────────────────────────

/**
 * Handle Rust-specific node types in the main AST traversal.
 * Returns true if the node was fully handled.
 */
function handleRustVisitNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type === 'source_file') {
    isExtractingPattern = false;
  }
  const nodeType = node.type;
  const source = ctx.source;
  const addRef = (ref: UnresolvedReference) => ctx.addUnresolvedReference(ref);

  // rust let/const/static — handled here to bypass generic extractVariable
  if (nodeType === 'let_declaration' || nodeType === 'const_item' || nodeType === 'static_item') {
    return extractRustVariable(node, ctx, nodeType, 'variable', undefined, undefined);
  }

  // match expressions
  if (nodeType === 'match_expression') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractMatchReferences(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  // if let expressions
  if (nodeType === 'if_let_expression') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractIfLetReferences(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  // macro_invocation
  if (nodeType === 'macro_invocation') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractMacroCall(node, source, addRef, ctx.nodeStack);
    extractMatchesMacroReferences(node, source, addRef, ctx.nodeStack);
    extractMacroInvocationArgs(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  // scoped_identifier in expression context (Rust only — other languages don't use Enum::Variant)
  if (nodeType === 'scoped_identifier' && !isExtractingPattern && ctx.nodeStack.length > 0) {
    extractScopedValueReference(node, source, addRef, ctx.nodeStack);
  }

  // type_arguments in expression context (Rust turbofish: Action::<Type>::new())
  if (nodeType === 'type_arguments' && ctx.nodeStack.length > 0) {
    const parent = node.parent;
    if (parent && (parent.type === 'generic_type' || parent.type === 'scoped_type_identifier')) {
      // Already handled by the parent node handler via extractTypeRefsFromSubtree
    } else {
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (fromNodeId && !fromNodeId.startsWith('file:')) {
        ctx.extractTypeRefsFromSubtree(node, fromNodeId, true);
      }
      return true; // skip children
    }
  }

  // macro_definition
  if (nodeType === 'macro_definition') {
    const macroNameNode = getChildByField(node, 'name');
    const macroName = macroNameNode ? getNodeText(macroNameNode, source) : '<unknown>';
    const macroNode = ctx.createNode('function', macroName, node);
    if (macroNode) {
      ctx.pushScope(macroNode.id);
      extractMacroTokenTreePatterns(node, macroNode.id, source, addRef);
      ctx.popScope();
    }
    return true;
  }

  // impl_item
  if (nodeType === 'impl_item') {
    extractRustImplItem(node, source, ctx.nodes, addRef, ctx.extractTypeRefsFromSubtree);
  }

  return false;
}

// ── visitNodeInBody helper ─────────────────────────────────────────

function handleRustVisitNodeInBody(node: SyntaxNode, visitChildren: (node: SyntaxNode) => void, ctx: ExtractorContext): boolean {
  const nodeType = node.type;
  const source = ctx.source;
  const addRef = (ref: UnresolvedReference) => ctx.addUnresolvedReference(ref);

  if (nodeType === 'match_expression') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractMatchReferences(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visitChildren(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  if (nodeType === 'if_let_expression') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractIfLetReferences(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visitChildren(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  if (nodeType === 'macro_invocation') {
    const saved = isExtractingPattern;
    isExtractingPattern = true;
    extractMacroCall(node, source, addRef, ctx.nodeStack);
    extractMatchesMacroReferences(node, source, addRef, ctx.nodeStack);
    extractMacroInvocationArgs(node, source, addRef, ctx.nodeStack);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visitChildren(child);
    }
    isExtractingPattern = saved;
    return true;
  }

  if (nodeType === 'scoped_identifier' && !isExtractingPattern && ctx.nodeStack.length > 0) {
    extractScopedValueReference(node, source, addRef, ctx.nodeStack);
  }

  if (nodeType === 'type_arguments' && ctx.nodeStack.length > 0) {
    const parent = node.parent;
    if (parent && (parent.type === 'generic_type' || parent.type === 'scoped_type_identifier')) {
      // Already handled by parent
    } else {
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (fromNodeId && !fromNodeId.startsWith('file:')) {
        ctx.extractTypeRefsFromSubtree(node, fromNodeId, true);
      }
      return true;
    }
  }

  return false;
}

// ── onExtractCall helper ───────────────────────────────────────────

function handleRustOnExtractCall(node: SyntaxNode, callerId: string, calleeName: string, ctx: ExtractorContext): void {
  const source = ctx.source;
  const addRef = (ref: UnresolvedReference) => ctx.addUnresolvedReference(ref);

  extractBevyCallRefs(node, callerId, calleeName, source, addRef);
  extractBevyNestedRefs(node, callerId, source, addRef);
  extractBevyStateCtorRefs(node, callerId, calleeName, source, addRef);
}

// ── Extractor definition ───────────────────────────────────────────

export const rustExtractor: LanguageExtractor = {
  functionTypes: ['function_item'],
  classTypes: [], // Rust has impl blocks
  methodTypes: ['function_item'], // Methods are functions in impl blocks
  interfaceTypes: ['trait_item'],
  structTypes: ['struct_item'],
  enumTypes: ['enum_item'],
  enumMemberTypes: ['enum_variant'],
  typeAliasTypes: ['type_item'], // Rust type aliases
  importTypes: ['use_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['let_declaration', 'const_item', 'static_item', 'parameter', 'closure_parameters'],
  fieldTypes: ['field_declaration'],
  interfaceKind: 'trait',
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  noForwardDeclarations: true,

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'visibility_modifier') {
        return child.text.includes('pub') ? 'public' : 'private';
      }
    }
    return 'private'; // Rust defaults to private
  },
  getReceiverType: (node, source) => {
    // Walk up the tree-sitter AST to find a parent impl_item
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'impl_item') {
        // For `impl Type { ... }` — the type is a direct type_identifier child
        // For `impl Trait for Type { ... }` — the type is the LAST type_identifier
        // (the first is part of the trait path)
        const children = parent.namedChildren;
        // Find all direct type_identifier children (not nested in scoped paths)
        const typeIdents = children.filter(
          (c: SyntaxNode) => c.type === 'type_identifier'
        );
        if (typeIdents.length > 0) {
          // Last type_identifier is always the implementing type
          const typeNode = typeIdents[typeIdents.length - 1]!;
          return source.substring(typeNode.startIndex, typeNode.endIndex);
        }
        // Handle generic types: impl<T> MyStruct<T> { ... }
        const genericType = children.find(
          (c: SyntaxNode) => c.type === 'generic_type'
        );
        if (genericType) {
          const innerType = genericType.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          );
          if (innerType) {
            return source.substring(innerType.startIndex, innerType.endIndex);
          }
        }
        // Handle scoped type identifier: impl Trait for crate::path::Type
        const scopedType = children.find(
          (c: SyntaxNode) => c.type === 'scoped_type_identifier'
        );
        if (scopedType) {
          const nameChildren = scopedType.namedChildren.filter(
            (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
          );
          const last = nameChildren[nameChildren.length - 1];
          if (last) {
            return source.substring(last.startIndex, last.endIndex);
          }
        }
        // Handle reference/pointer types: impl Trait for &Type / *const Type
        const refType = children.find(
          (c: SyntaxNode) => c.type === 'reference_type' || c.type === 'pointer_type'
        );
        if (refType) {
          const innerName = refType.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          );
          if (innerName) {
            return source.substring(innerName.startIndex, innerName.endIndex);
          }
        }
        // Handle tuple type: impl Trait for (A, B)
        const tupleType = children.find(
          (c: SyntaxNode) => c.type === 'tuple_type'
        );
        if (tupleType) {
          return source.substring(tupleType.startIndex, tupleType.endIndex);
        }
        return undefined;
      }
      parent = parent.parent;
    }
    return undefined;
  },

  extractVariables: (node, source) => {
    const results: Array<{ name: string; kind: NodeKind; signature?: string; positionNode?: SyntaxNode }> = [];

    if (node.type === 'parameter') {
      const patternNode = getChildByField(node, 'pattern');
      if (!patternNode) return [];
      const name = getNodeText(patternNode, source);
      if (!name || name === '_') return [];
      const typeNode = getChildByField(node, 'type');
      const signature = typeNode ? getNodeText(typeNode, source) : undefined;
      results.push({ name, kind: 'parameter', signature, positionNode: patternNode });
      return results;
    }

    if (node.type === 'closure_parameters') {
      // Walk up parent chain to find enclosing call_expression for method name.
      // Start from closure_expression.parent (skip the closure_expression wrapper
      // that is always the immediate parent of closure_parameters).
      let methodName: string | undefined;
      let parent = node.parent?.parent; // skip closure_expression → get arguments or expression
      while (parent) {
        if (parent.type === 'function_item' || parent.type === 'closure_expression') break;
        if (parent.type === 'call_expression') {
          const funcNode = getChildByField(parent, 'function');
          if (funcNode) {
            const fullName = getNodeText(funcNode, source);
            const lastDot = fullName.lastIndexOf('.');
            methodName = lastDot >= 0 ? fullName.slice(lastDot + 1) : fullName;
          }
          break;
        }
        parent = parent.parent;
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'parameter') {
          const patternNode = getChildByField(child, 'pattern');
          if (!patternNode) continue;
          const name = getNodeText(patternNode, source);
          if (!name || name === '_') continue;
          results.push({
            name,
            kind: 'parameter',
            // Only store method name as signature when there's no explicit type
            // annotation, so Tier 1.5 type inference has a fallback to work with.
            // Parameters with type annotations already get type_of edges from
            // the normal visitNode flow.
            signature: getChildByField(child, 'type') ? undefined : methodName,
            positionNode: patternNode,
          });
        }
      }
      return results;
    }

    return [];
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // Helper to get the root crate/module from a scoped path
    const getRootModule = (scopedNode: SyntaxNode): string => {
      const firstChild = scopedNode.namedChild(0);
      if (!firstChild) return source.substring(scopedNode.startIndex, scopedNode.endIndex);
      if (firstChild.type === 'identifier' ||
          firstChild.type === 'crate' ||
          firstChild.type === 'super' ||
          firstChild.type === 'self') {
        return source.substring(firstChild.startIndex, firstChild.endIndex);
      } else if (firstChild.type === 'scoped_identifier') {
        return getRootModule(firstChild);
      }
      return source.substring(firstChild.startIndex, firstChild.endIndex);
    };

    // Find the use argument (scoped_use_list or scoped_identifier)
    const useArg = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'scoped_use_list' ||
      c.type === 'scoped_identifier' ||
      c.type === 'use_list' ||
      c.type === 'identifier'
    );

    if (useArg) {
      return { moduleName: getRootModule(useArg), signature: importText };
    }
    return null;
  },

  // ── Hooks ──────────────────────────────────────────────────

  visitNode: (node, ctx) => {
    return handleRustVisitNode(node, ctx);
  },

  visitNodeInBody: (node, visitChildren, ctx) => {
    return handleRustVisitNodeInBody(node, visitChildren, ctx);
  },

  onExtractCall: (node, callerId, calleeName, ctx) => {
    handleRustOnExtractCall(node, callerId, calleeName, ctx);
  },

  shouldSuppressCall: (node, _calleeName, source) => {
    // Rust struct update syntax: Struct { ..default() } — the call inside
    // .. position is a value expression, not a project-internal call.
    const beforeText = source.slice(Math.max(0, node.startIndex - 200), node.startIndex);
    return /(?:^|[,\s{])\s*\.\.\s*$/.test(beforeText);
  },

  resolveTypeRefKind: (insideTypeArgs) => {
    // Inside turbofish type arguments, emit 'type_of' so resolution
    // prefers type symbols (struct, enum) over value symbols.
    return insideTypeArgs ? 'type_of' : undefined;
  },

  postExtract: (ctx) => {
    scanBevyPatternsFallback(ctx);
    scanAttributeTypeRefs(ctx);
  },
};
