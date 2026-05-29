/**
 * Comment-to-symbol association (fork extension).
 *
 * Pure function — zero dependencies beyond the TypeScript standard library.
 */

export function associateCommentWithSymbol(
  comment: { startLine: number; endLine: number; kind: string },
  candidates: Array<{ startLine: number; endLine: number; name: string; qualifiedName?: string }>,
): string | undefined {
  // Find nearest enclosing symbol
  for (const node of candidates) {
    if (node.startLine <= comment.startLine && node.endLine >= comment.endLine) {
      return node.qualifiedName ?? node.name;
    }
  }

  // Doc comments appear BEFORE the documented item. Fall back to the
  // nearest candidate whose startLine follows the comment's endLine.
  if (comment.kind === 'doc') {
    let bestGap = Infinity;
    let bestSymbol: string | undefined;
    for (const node of candidates) {
      const gap = node.startLine - comment.endLine;
      if (gap >= 1 && gap <= 3 && gap < bestGap) {
        bestGap = gap;
        bestSymbol = node.qualifiedName ?? node.name;
      }
    }
    if (bestSymbol) return bestSymbol;
  }

  return undefined;
}
