/**
 * Bevy ECS resource dataflow synthesizer.
 *
 * insert_resource(T) → resource_exists<T> signals.
 * When fn A calls commands.insert_resource(X) and fn B is registered with
 * .run_if(resource_exists::<X>()), synthesize a calls edge A→B so trace
 * can follow the dataflow through the ECS command queue.
 */
import type { Edge } from '../../types';
import type { ResolutionContext } from '../types';
import { stripRustComments } from './bevy-utils';

// Group 1 = turbofish type (commands.insert_resource::<Type>(...)),
// group 2 = constructor arg (base type, stops before ::Variant).
// Uses Unicode-aware [\p{L}\p{N}_] so CJK type names match.
const INSERT_RESOURCE_RE = /[\p{L}\p{N}_]+\s*\.\s*insert_resource\s*(?:::\s*<([\p{L}\p{N}_<>,: >]+)>\s*)?\(\s*([\p{L}\p{N}_]+)(?:::[\p{L}\p{N}_]+(?:\([^)]*\))?)*\s*[;{)]/gu;
const RESOURCE_EXISTS_RE = /run_if\s*\(\s*resource_exists\s*::\s*<\s*([\p{L}\p{N}_<>,: >]+)\s*>\s*\)/gu;

export function bevyEcsEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const resources = new Map<string, { inserters: Set<string>; checkers: Set<string> }>();
  const fnLines = new Map<string, number>();

  function ensure(r: string) {
    if (!resources.has(r)) resources.set(r, { inserters: new Set(), checkers: new Set() });
    return resources.get(r)!;
  }

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const raw = ctx.readFile(file);
    if (!raw) continue;
    const content = stripRustComments(raw);

    const fileNodes = ctx.getNodesInFile(file);
    const fns = fileNodes.filter((n: { kind: string }) => n.kind === 'function' || n.kind === 'method');

    INSERT_RESOURCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSERT_RESOURCE_RE.exec(content))) {
      const typeName = (m[1] || m[2])!.trim();
      const line = content.substring(0, m.index).split('\n').length;
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) {
          ensure(typeName).inserters.add(fn.id);
          fnLines.set(fn.id, line);
          break;
        }
      }
    }

    RESOURCE_EXISTS_RE.lastIndex = 0;
    while ((m = RESOURCE_EXISTS_RE.exec(content))) {
      const typeName = m[1]!.trim();
      const line = content.substring(0, m.index).split('\n').length;
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) {
          ensure(typeName).checkers.add(fn.id);
          fnLines.set(fn.id, line);
          break;
        }
      }
    }
  }

  for (const [, data] of resources) {
    if (data.inserters.size === 0 || data.checkers.size === 0) continue;
    for (const inserterId of data.inserters) {
      for (const checkerId of data.checkers) {
        edges.push({
          source: inserterId,
          target: checkerId,
          kind: 'calls',
          line: fnLines.get(inserterId),
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-resource' },
        });
      }
    }
  }

  return edges;
}
