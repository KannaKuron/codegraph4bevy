/**
 * Bevy ECS observer trigger dataflow synthesizer (Issue #3).
 *
 * commands.trigger(X) → observer handler dataflow.
 * When fn A calls commands.trigger(MyEvent) and fn B handles
 * Trigger<MyEvent> / On<MyEvent>, synthesize a calls edge A→B so trace
 * can follow the dataflow through the ECS observer system.
 *
 * Follows the same producer-consumer pattern as bevy-ecs.ts
 * (insert_resource → resource_exists).
 */
import type { Edge } from '../../types';
import type { ResolutionContext } from '../types';
import { stripRustComments } from './bevy-utils';

// Group 1 = event type name from .trigger(EventType ...) calls.
// Uses Unicode-aware [\p{L}\p{N}_] for CJK type names.
const TRIGGER_CALL_RE = /\.trigger\s*\(\s*([\p{L}\p{N}_]+)/gu;

// Match Trigger<E>, Trigger<On<E, ...>>, On<E>, On<E, ...> in function
// signatures. Captures the event type E (simple name, stops at angle brackets).
// LIFECYCLE_HOOKS set filters out On<Add/Insert/Remove/Replace/Despawn>.
const OBSERVER_TYPE_RE = /(?:Trigger|On)\s*<\s*(?:On\s*<\s*)?([\p{L}\p{N}_]+)/gu;

const LIFECYCLE_HOOKS = new Set(['Add', 'Insert', 'Remove', 'Replace', 'Despawn']);

export function bevyObserverEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const events = new Map<string, { producers: Set<string>; consumers: Set<string> }>();
  const fnLines = new Map<string, number>();

  function ensure(r: string) {
    if (!events.has(r)) events.set(r, { producers: new Set(), consumers: new Set() });
    return events.get(r)!;
  }

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const raw = ctx.readFile(file);
    if (!raw) continue;
    const content = stripRustComments(raw);

    const fileNodes = ctx.getNodesInFile(file);
    const fns = fileNodes.filter(
      (n: { kind: string }) => n.kind === 'function' || n.kind === 'method',
    );

    // 1. Scan for .trigger(EventType ...) call sites (producers)
    TRIGGER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRIGGER_CALL_RE.exec(content))) {
      const eventType = m[1]!.trim();
      const line = content.substring(0, m.index).split('\n').length;
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) {
          ensure(eventType).producers.add(fn.id);
          fnLines.set(fn.id, line);
          break;
        }
      }
    }

    // 2. Find observer handler functions via signature (consumers)
    for (const fn of fns) {
      const sig = fn.signature;
      if (!sig) continue;
      OBSERVER_TYPE_RE.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = OBSERVER_TYPE_RE.exec(sig))) {
        const eventType = sm[1]!.trim();
        if (LIFECYCLE_HOOKS.has(eventType)) continue;
        ensure(eventType).consumers.add(fn.id);
      }
    }
  }

  // 3. Synthesize calls edges (producer → consumer) by matching event types
  for (const [, data] of events) {
    if (data.producers.size === 0 || data.consumers.size === 0) continue;
    for (const producerId of data.producers) {
      for (const consumerId of data.consumers) {
        edges.push({
          source: producerId,
          target: consumerId,
          kind: 'calls',
          line: fnLines.get(producerId),
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-observer' },
        });
      }
    }
  }

  return edges;
}
