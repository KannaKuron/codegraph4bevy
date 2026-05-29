/**
 * Fork extension: recursive descendant traversal.
 *
 * Extracted from `GraphTraverser.getDescendantsRecursive` so that
 * upstream changes to traversal.ts rarely touch this file.
 */

import { Node } from '../types';

/**
 * Recursively collect all descendants up to `maxDepth` levels deep.
 * Used by receiver-resolver for parameter scope traversal.
 *
 * @param nodeId  Root node to start from (not included in result).
 * @param getChildren  Callback that returns direct children of a node.
 * @param maxDepth  Maximum recursion depth (default 10).
 */
export function getDescendantsRecursive(
  nodeId: string,
  getChildren: (id: string) => Node[],
  maxDepth: number = 10,
): Node[] {
  const result: Node[] = [];
  const visited = new Set<string>();
  collectDescendants(nodeId, 0, maxDepth, result, visited, getChildren);
  return result;
}

function collectDescendants(
  nodeId: string,
  depth: number,
  maxDepth: number,
  result: Node[],
  visited: Set<string>,
  getChildren: (id: string) => Node[],
): void {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);
  if (depth >= maxDepth) return;

  const children = getChildren(nodeId);
  for (const child of children) {
    result.push(child);
    collectDescendants(child.id, depth + 1, maxDepth, result, visited, getChildren);
  }
}
