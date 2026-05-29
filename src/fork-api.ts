/**
 * Fork API extensions.
 *
 * Complex query functions extracted from the CodeGraph class in index.ts.
 * Accept `QueryBuilder` / `GraphTraverser` as parameters so they can be
 * called from thin class wrappers without duplicating logic.
 */

import { QueryBuilder } from './db/queries';
import { GraphTraverser } from './graph';
import { resolveReceiverType } from './bevy/receiver-resolver';

/**
 * Search for macro call sites by macro name.
 * Returns deduplicated call locations from unresolved macro_call references.
 */
export function searchMacroCalls(
  queries: QueryBuilder,
  name: string,
  limit: number = 500,
): Array<{ filePath: string; line: number; column: number; fromNodeId: string }> {
  const normalized = name.endsWith('!') ? name.slice(0, -1) : name;
  const refs = queries.getUnresolvedByName(normalized);
  const seen = new Set<string>();
  const results: Array<{ filePath: string; line: number; column: number; fromNodeId: string }> = [];
  for (const ref of refs) {
    if (ref.referenceKind !== 'macro_call') continue;
    const key = `${ref.filePath}:${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ filePath: ref.filePath ?? '', line: ref.line, column: ref.column, fromNodeId: ref.fromNodeId });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Search for method call sites by method name.
 */
export function searchMethodCalls(
  queries: QueryBuilder,
  traverser: GraphTraverser,
  name: string,
  limit: number = 500,
): Array<{ filePath: string; line: number; column: number; fromNodeId: string; receiverHint: string; declaredType?: string }> {
  const seen = new Set<string>();
  const results: Array<{ filePath: string; line: number; column: number; fromNodeId: string; receiverHint: string; declaredType?: string }> = [];

  const refs = queries.getUnresolvedByName(name);
  for (const ref of refs) {
    if (ref.referenceKind !== 'method_call') continue;
    const key = `${ref.filePath}:${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const callerRefs = queries.getUnresolvedByNode(ref.fromNodeId);
    let receiverHint = '';
    for (const cr of callerRefs) {
      if (cr.referenceKind === 'calls' && cr.line === ref.line && cr.referenceName.endsWith(`.${name}`)) {
        receiverHint = cr.referenceName.slice(0, -(name.length + 1));
        break;
      }
    }
    const declaredType = receiverHint ? resolveReceiverType(ref.fromNodeId, receiverHint, queries, traverser, name) : undefined;
    results.push({ filePath: ref.filePath ?? '', line: ref.line, column: ref.column, fromNodeId: ref.fromNodeId, receiverHint, declaredType });
    if (results.length >= limit) return results;
  }

  const methodNodes = queries.getNodesByName(name);
  for (const methodNode of methodNodes) {
    const incomingCalls = queries.getIncomingEdges(methodNode.id, ['calls']);
    for (const edge of incomingCalls) {
      const sourceNode = queries.getNodeById(edge.source);
      if (!sourceNode) continue;
      const key = `${sourceNode.filePath}:${edge.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let declaredType: string | undefined;
      const qn = methodNode.qualifiedName;
      if (qn) {
        const lastColon = qn.lastIndexOf('::');
        if (lastColon > 0) {
          declaredType = qn.slice(0, lastColon);
        }
      }
      results.push({
        filePath: sourceNode.filePath,
        line: edge.line ?? sourceNode.startLine,
        column: 0,
        fromNodeId: edge.source,
        receiverHint: '',
        declaredType,
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}
