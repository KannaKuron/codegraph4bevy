/**
 * Shared utilities for Bevy synthesizer modules.
 *
 * Extracted from callback-synthesizer.ts so that upstream refactors
 * to that file don't conflict with Bevy-specific helper code.
 */
import type { Node } from '../../types';
import type { ResolutionContext } from '../types';

// =============================================================================
// stripRustComments
// =============================================================================

/**
 * Strip Rust line (//) and block comments, strings, char literals,
 * and raw/byte strings to avoid false matches in dead text.
 * Preserves newlines so line numbers stay valid.
 */
export function stripRustComments(src: string): string {
  let result = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      result += '\n'.repeat(src.substring(i, nl).split('\n').length - 1) + '\n';
      i = nl + 1;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length - 1 && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
        else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
        else { result += src[j] === '\n' ? '\n' : ' '; j++; }
      }
      if (depth > 0) {
        while (j < src.length) { result += src[j] === '\n' ? '\n' : ' '; j++; }
      }
      result += '  ';
      i = j;
    } else if (src[i] === "'") {
      result += ' ';
      i++;
      if (i < src.length && src[i] === '\\') {
        result += ' '; i++;
        if (i < src.length && src[i] === 'x') {
          result += ' '; i++;
          while (i < src.length && src[i] !== "'") { result += ' '; i++; }
        } else if (i < src.length && src[i] === 'u') {
          result += ' '; i++;
          if (i < src.length && src[i] === '{') {
            result += ' '; i++;
            while (i < src.length && src[i] !== '}') { result += ' '; i++; }
            if (i < src.length) { result += ' '; i++; }
          }
        } else {
          while (i < src.length && src[i] !== "'") {
            if (src[i] === '\n') result += '\n'; else result += ' ';
            i++;
          }
        }
      } else {
        while (i < src.length && src[i] !== "'") {
          if (src[i] === '\n') result += '\n'; else result += ' ';
          i++;
        }
      }
      if (i < src.length) { result += ' '; i++; }
    } else if (src[i] === '"') {
      if (src[i - 1] === 'b' || (i >= 2 && src[i - 1] === 'r' && src[i - 2] === 'b')) {
        // byte string b"…" / br"…" — treat same as regular string
        result += ' '; i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { result += ' '; i++; }
          if (src[i] === '\n') result += '\n'; else result += ' ';
          if (i < src.length) i++;
        }
        if (i < src.length) { result += ' '; i++; }
      } else {
        result += ' '; i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { result += ' '; i++; }
          if (src[i] === '\n') result += '\n'; else result += ' ';
          if (i < src.length) i++;
        }
        if (i < src.length) { result += ' '; i++; }
      }
    } else if (src[i] === 'b' && src[i + 1] === 'r' && (src[i + 2] === '#' || src[i + 2] === '"')) {
      // byte raw string br#"…"# or br"…"
      if (src[i + 2] === '#') {
        let hashes = 0;
        let j = i + 2;
        while (j < src.length && src[j] === '#') { hashes++; j++; }
        if (j < src.length && src[j] === '"') {
          j++;
          const closing = '"' + '#'.repeat(hashes);
          const end = src.indexOf(closing, j);
          if (end >= 0) {
            for (let k = i; k < end + closing.length; k++) {
              result += src[k] === '\n' ? '\n' : ' ';
            }
            i = end + closing.length;
          } else {
            for (let k = i; k < src.length; k++) {
              result += src[k] === '\n' ? '\n' : ' ';
            }
            i = src.length;
          }
        } else {
          result += src[i]; i++;
        }
      } else {
        // br"…"
        let j = i + 3;
        const end = src.indexOf('"', j);
        if (end >= 0) {
          for (let k = i; k <= end; k++) {
            result += src[k] === '\n' ? '\n' : ' ';
          }
          i = end + 1;
        } else {
          for (let k = i; k < src.length; k++) {
            result += src[k] === '\n' ? '\n' : ' ';
          }
          i = src.length;
        }
      }
    } else if (src[i] === 'r') {
      if (src[i + 1] === '#') {
        let hashes = 0;
        let j = i + 1;
        while (j < src.length && src[j] === '#') { hashes++; j++; }
        if (j < src.length && src[j] === '"') {
          j++;
          const closing = '"' + '#'.repeat(hashes);
          const end = src.indexOf(closing, j);
          if (end >= 0) {
            for (let k = i; k < end + closing.length; k++) {
              result += src[k] === '\n' ? '\n' : ' ';
            }
            i = end + closing.length;
          } else {
            for (let k = i; k < src.length; k++) {
              result += src[k] === '\n' ? '\n' : ' ';
            }
            i = src.length;
          }
        } else {
          result += src[i]; i++;
        }
      } else if (src[i + 1] === '"') {
        let j = i + 2;
        const end = src.indexOf('"', j);
        if (end >= 0) {
          for (let k = i; k <= end; k++) {
            result += src[k] === '\n' ? '\n' : ' ';
          }
          i = end + 1;
        } else {
          for (let k = i; k < src.length; k++) {
            result += src[k] === '\n' ? '\n' : ' ';
          }
          i = src.length;
        }
      } else {
        result += src[i]; i++;
      }
    } else {
      result += src[i]; i++;
    }
  }
  return result;
}

// =============================================================================
// extractBlock
// =============================================================================

/** Extract a bracket-delimited block starting at position `open` in `src`. */
export function extractBlock(src: string, open: number): string | null {
  const openChar = src[open];
  if (openChar !== '{' && openChar !== '(') return null;
  const closer = openChar === '{' ? '}' : ')';
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === openChar) depth++;
    else if (src[i] === closer) depth--;
    i++;
  }
  return depth === 0 ? src.slice(open + 1, i - 1) : null;
}

// =============================================================================
// resolveNode
// =============================================================================

/** Find the first node named `name` in `file`, then fall back to global search. */
export function resolveNode(name: string, file: string, ctx: ResolutionContext): Node | null {
  const fileNodes = ctx.getNodesInFile(file);
  const match = fileNodes.find(n => n.name === name);
  if (match) return match;
  const global = ctx.getNodesByName(name);
  const result = global.find(n => ['struct', 'class', 'function', 'method'].includes(n.kind)) ?? global[0];
  if (result) return result;
  // Fallback: try qualified name lookup for paths like "module::handler"
  const qualified = ctx.getNodesByQualifiedName(name);
  return qualified.find(n => ['struct', 'class', 'function', 'method'].includes(n.kind)) ?? qualified[0] ?? null;
}

// =============================================================================
// parseHandlerNames / splitTopLevelCommas
// =============================================================================

/** Split by commas at brace-depth 0. */
export function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '<') depth++;
    else if (s[i] === ')' || s[i] === '>') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * Parse system function names from add_systems handler arguments.
 * Handles: single fn, scoped fn (a::b), tuples (a, b), and simple
 * method chains (fn.run_if(…).after(…)).
 */
export function parseHandlerNames(handlerExpr: string): string[] {
  const names: string[] = [];
  const trimmed = handlerExpr.trim();
  if (!trimmed) return names;

  if (trimmed.startsWith('(')) {
    const inner = extractBlock('(' + trimmed.slice(1), 0);
    if (inner) {
      const parts = splitTopLevelCommas(inner);
      for (const p of parts) names.push(...parseHandlerNames(p));
    }
    return names;
  }

  const firstId = /^([\p{L}\p{N}_]+(?:::\s*[\p{L}\p{N}_]+)*)/u.exec(trimmed);
  if (firstId) names.push(firstId[1]!.replace(/\s+/g, ''));
  return names;
}
