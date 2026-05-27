/**
 * Rust receiver type resolution — extracted from CodeGraph class.
 *
 * Resolves the declared type for a variable by following type_of edges,
 * with Bevy-specific fallbacks for well-known patterns.
 */
import { logWarn } from '../errors';
import type { QueryBuilder } from '../db/queries';
import type { GraphTraverser } from '../graph';

/**
 * Extract the base type name from a Rust parameter signature.
 * Handles: "&mut Commands" → "Commands", "ResMut<Commands>" → "Commands",
 * "Res<AssetServer>" → "AssetServer", "Option<&mut Commands>" → "Commands",
 * "Commands" → "Commands", "Query<&T>" → "Query".
 *
 * Bevy system param wrappers (Res, ResMut, NonSend, NonSendMut) are
 * unwrapped to their inner type because they Deref/DerefMut to it —
 * method calls on these wrappers resolve against the inner type.
 */
export function extractBaseTypeFromSignature(sig: string): string | undefined {
  let s = sig.trim();
  s = s.replace(/^&(?:mut\s+)?/, '');
  while (s.startsWith('Option<') && s.endsWith('>')) {
    s = s.slice(7, -1).trim();
    s = s.replace(/^&(?:mut\s+)?/, '');
  }
  const angleIdx = s.indexOf('<');
  if (angleIdx > 0) {
    const baseType = s.slice(0, angleIdx).trim();
    if (baseType === 'Res' || baseType === 'ResMut' || baseType === 'NonSend' || baseType === 'NonSendMut') {
      const closeIdx = s.lastIndexOf('>');
      if (closeIdx > angleIdx) {
        const inner = s.slice(angleIdx + 1, closeIdx).trim().replace(/^&(?:mut\s+)?/, '');
        if (inner && /^[A-Z\p{Lu}]/u.test(inner)) {
          return inner;
        }
      }
    }
    s = baseType;
  }
  s = s.trim();
  if (s && /^[A-Z\p{Lu}]/u.test(s)) {
    return s;
  }
  return undefined;
}

/**
 * Resolve the declared type name for a variable by following type_of edges.
 * Three-tier resolution:
 *
 * Tier 1: Search all descendants for a parameter node with matching name,
 *         then follow type_of edges to get declared type.
 * Tier 2: For closure parameters without type annotations, look up the method
 *         in external_symbols to infer the type.
 * Tier 3: Hardcoded fallback for well-known Bevy patterns.
 */
export function resolveReceiverType(
  fromNodeId: string,
  varName: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
  methodName?: string,
): string | undefined {
  // Tier 1: Recursive parameter search with type_of / references edges
  const descendants = traverser.getDescendantsRecursive(fromNodeId);
  for (const child of descendants) {
    if (child.kind === 'parameter' && child.name === varName) {
      let typeEdges = queries.getOutgoingEdges(child.id, ['type_of']);
      if (typeEdges.length === 0) {
        typeEdges = queries.getOutgoingEdges(child.id, ['references']);
      }
      if (typeEdges.length > 0) {
        const typeNode = queries.getNodeById(typeEdges[0]!.target);
        if (typeNode) return typeNode.name;
      }
      const sig = child.signature;
      if (sig) {
        const extractedType = extractBaseTypeFromSignature(sig);
        if (extractedType) return extractedType;
        // Tier 1.5: Closure parameter type inference from external_symbols.
        if (sig.length > 0 && !/[<: ]/u.test(sig)) {
          const types = queries.findTypesByMethod(sig);
          let bestName: string | undefined;
          for (const t of types) {
            if (t.paramTypes) {
              try {
                const paramTypes: string[] = JSON.parse(t.paramTypes);
                for (const pt of paramTypes) {
                  let p = pt.trim();
                  if (/^&?(?:mut\s+)?self$/i.test(p)) continue;
                  p = p.replace(/^impl\s+/, '');
                  const fnMatch = p.match(/^(FnOnce|FnMut|Fn)\s*\(\s*(.+)\s*\)$/);
                  if (fnMatch) {
                    const inner = fnMatch[2]!.split(',')[0]!.trim();
                    const innerType = extractBaseTypeFromSignature(inner);
                    if (innerType) return innerType;
                    continue;
                  }
                  const directType = extractBaseTypeFromSignature(p);
                  if (directType) return directType;
                }
              } catch (e) {
                logWarn(`[resolveReceiverType] Failed to parse param_types for type "${t.symbolName}" with method "${sig}": ${(e as Error).message}`);
              }
            }
            if (!bestName) bestName = t.symbolName;
          }
          if (bestName) return bestName;
        }
      }
      continue;
    }
  }

  // Immediate children (backward compat — non-parameter variable declarations)
  const children = traverser.getChildren(fromNodeId);
  for (const child of children) {
    if (child.name === varName && child.kind !== 'parameter') {
      const typeEdges = queries.getOutgoingEdges(child.id, ['type_of']);
      if (typeEdges.length > 0) {
        const typeNode = queries.getNodeById(typeEdges[0]!.target);
        if (typeNode) return typeNode.name;
      }
    }
  }

  // Tier 2: Generalized external symbol lookup by method name
  if (methodName) {
    const types = queries.findTypesByMethod(methodName);
    if (types.length > 0) return types[0]!.symbolName;
  }

  // Tier 3: Hardcoded fallback for well-known Bevy patterns
  if (methodName) {
    if (methodName === 'with_children' || methodName === 'spawn_children') {
      return 'ChildBuilder';
    }
    if (methodName === 'with_related_entities') {
      return 'EntityCommands';
    }
    if (methodName === 'spawn' || methodName === 'insert' || methodName === 'remove' || methodName === 'despawn') {
      return 'EntityCommands';
    }
    if (methodName === 'entity' || methodName === 'commands' || methodName === 'id'
      || methodName === 'entry' || methodName === 'with_child'
      || methodName === 'spawn_empty' || methodName === 'spawn_batch') {
      return 'EntityCommands';
    }
    if (methodName === 'single' || methodName === 'get' || methodName === 'iter') {
      return 'Query';
    }
    if (methodName === 'iter_mut' || methodName === 'get_single' || methodName === 'query') {
      return 'Query';
    }
    if (methodName === 'send' || methodName === 'send_batch' || methodName === 'trigger') {
      return 'EventWriter';
    }
    if (methodName === 'set') {
      return 'NextState';
    }
  }

  return undefined;
}
