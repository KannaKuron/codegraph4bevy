/**
 * Bevy Relationship synthesizer (Issue #7).
 *
 * Parses #[relationship(relationship_target = X)] and
 * #[relationship_target(relationship = X)] attributes in Rust source
 * to create references edges between Relationship and RelationshipTarget
 * struct pairs (e.g. ChildOf → Children).
 *
 * These attributes are in the raw source text — no proc-macro expansion
 * needed. Similar approach to bevy-state.ts's #[source(...)] parsing.
 */
import type { Edge } from '../../types';
import type { ResolutionContext } from '../types';
import { stripRustComments } from './bevy-utils';

const RELATIONSHIP_ATTR_RE = /#\[\s*relationship\s*\(\s*relationship_target\s*=\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*[^)]*\)\s*\]/gu;
const RELATIONSHIP_TARGET_ATTR_RE = /#\[\s*relationship_target\s*\(\s*relationship\s*=\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*[^)]*\)\s*\]/gu;

export function bevyRelationshipEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const raw = ctx.readFile(file);
    if (!raw) continue;
    const content = stripRustComments(raw);
    const fileNodes = ctx.getNodesInFile(file);

    // Parse #[relationship(relationship_target = X)]
    RELATIONSHIP_ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RELATIONSHIP_ATTR_RE.exec(content))) {
      const targetName = m[1]!.replace(/\s+/g, '');
      const shortName = targetName.split('::').pop() ?? targetName;
      const attrLine = content.substring(0, m.index).split('\n').length;

      // Find the struct defined after this attribute
      const sourceNode = findNextStruct(attrLine, fileNodes);
      if (!sourceNode) continue;

      const targetNodes = ctx.getNodesByName(shortName).filter(n => n.kind === 'struct');
      for (const tn of targetNodes) {
        const key = `${sourceNode.id}>${tn.id}>references>relationship`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: sourceNode.id,
          target: tn.id,
          kind: 'references',
          line: attrLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-relationship' },
        });
      }
    }

    // Parse #[relationship_target(relationship = X)]
    RELATIONSHIP_TARGET_ATTR_RE.lastIndex = 0;
    while ((m = RELATIONSHIP_TARGET_ATTR_RE.exec(content))) {
      const sourceName = m[1]!.replace(/\s+/g, '');
      const shortName = sourceName.split('::').pop() ?? sourceName;
      const attrLine = content.substring(0, m.index).split('\n').length;

      const targetNode = findNextStruct(attrLine, fileNodes);
      if (!targetNode) continue;

      const sourceNodes = ctx.getNodesByName(shortName).filter(n => n.kind === 'struct');
      for (const sn of sourceNodes) {
        const key = `${targetNode.id}>${sn.id}>references>relationship_target`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: targetNode.id,
          target: sn.id,
          kind: 'references',
          line: attrLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-relationship' },
        });
      }
    }
  }

  return edges;
}

/** Find the first struct node whose startLine is at or after `searchFromLine`. */
function findNextStruct(
  attrLine: number,
  fileNodes: ReturnType<ResolutionContext['getNodesInFile']>,
): typeof fileNodes[number] | null {
  // Find the struct that immediately follows the attribute.
  // The attribute is on the line(s) before the struct definition.
  // We look for a struct node whose startLine is >= attrLine and within
  // a few lines of the attribute (accounting for other attributes like #[derive]).
  const MAX_GAP = 10;
  let best: typeof fileNodes[number] | null = null;
  let bestDist = Infinity;
  for (const node of fileNodes) {
    if (node.kind !== 'struct') continue;
    const dist = node.startLine - attrLine;
    if (dist >= 0 && dist <= MAX_GAP && dist < bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return best;
}
