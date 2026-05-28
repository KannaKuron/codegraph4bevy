/**
 * Bevy-specific formatting helpers for MCP tools.
 *
 * Extracted from tools.ts so upstream refactors to that file don't
 * conflict with Bevy-specific edge labeling, risk classification,
 * and mutability detection.
 */
import type { Edge, Node } from '../types';
import type { CodeGraph } from '../index';

// =============================================================================
// synthEdgeNote Bevy branches
// =============================================================================

export interface SynthNote {
  label: string;
  compact: string;
  registeredAt?: string;
}

export function bevySynthEdgeNote(
  edge: Edge,
): SynthNote | null {
  const m = edge.metadata as Record<string, unknown> | undefined;
  const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
  const at = registeredAt ? ` @${registeredAt}` : '';

  if (m?.synthesizedBy === 'bevy-ecs-state') {
    const via = m.transitiveVia
      ? ` (derived via ComputedStates from \`${String(m.transitiveVia)}\`)`
      : '';
    return {
      label: `Bevy state transition — producer triggers consumer via state change${via} (dynamic dispatch)`,
      compact: `dynamic: Bevy state transition${via ? ` [computed]` : ''}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'bevy-ecs-resource') {
    return {
      label: `Bevy ECS resource — insert triggers resource check (dynamic dispatch)`,
      compact: `dynamic: Bevy ECS resource${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'bevy-dsl') {
    const plugin = typeof m.plugin === 'string' ? ` by ${m.plugin}` : '';
    const schedule = typeof m.schedule === 'string' ? m.schedule : undefined;
    switch (edge.kind) {
      case 'on_transition': {
        const from = typeof m.transitionFrom === 'string' ? m.transitionFrom : '?';
        const to = typeof m.transitionTo === 'string' ? m.transitionTo : '?';
        return {
          label: `Bevy state transition — OnTransition<${from}, ${to}> system trigger${plugin} (dynamic dispatch)`,
          compact: `dynamic: OnTransition<${from}, ${to}>${plugin}${at}`,
          registeredAt,
        };
      }
      case 'on_enter':
        return {
          label: `Bevy state enter — system runs on state change${plugin} (dynamic dispatch)`,
          compact: `dynamic: OnEnter${plugin}${at}`,
          registeredAt,
        };
      case 'on_exit':
        return {
          label: `Bevy state exit — system runs on state change${plugin} (dynamic dispatch)`,
          compact: `dynamic: OnExit${plugin}${at}`,
          registeredAt,
        };
      case 'runs_in':
        return {
          label: `Bevy schedule — system runs in ${schedule ?? 'unknown'}${plugin} (dynamic dispatch)`,
          compact: `dynamic: runs in ${schedule ?? 'unknown'}${plugin}${at}`,
          registeredAt,
        };
      case 'registers_system':
        return {
          label: `Bevy system registration — plugin registers system for ${schedule ?? 'unknown'} (dynamic dispatch)`,
          compact: `dynamic: system for ${schedule ?? 'unknown'}${at}`,
          registeredAt,
        };
      case 'registers_resource':
        return {
          label: `Bevy resource — plugin registers resource (dynamic dispatch)`,
          compact: `dynamic: register resource${at}`,
          registeredAt,
        };
      case 'registers_message':
        return {
          label: `Bevy message — plugin registers event/message (dynamic dispatch)`,
          compact: `dynamic: register message${at}`,
          registeredAt,
        };
      case 'contains_plugin':
        return {
          label: `Bevy plugin group — contains plugin (dynamic dispatch)`,
          compact: `dynamic: contains plugin${at}`,
          registeredAt,
        };
      default:
        return {
          label: `Bevy DSL — ${edge.kind}${plugin} (dynamic dispatch)`,
          compact: `dynamic: ${edge.kind}${plugin}${at}`,
          registeredAt,
        };
    }
  }
  return null;
}

// =============================================================================
// formatSchedule — Bevy schedule registration info
// =============================================================================

export function formatSchedule(cg: CodeGraph, node: Node): string {
  if (node.kind !== 'function' && node.kind !== 'method') return '';
  const runsInEdges = cg.getOutgoingEdges(node.id, ['runs_in']);
  if (runsInEdges.length === 0) return '';
  const lines: string[] = [];
  for (const edge of runsInEdges) {
    const schedNode = cg.getNode(edge.target);
    const schedName = schedNode?.name ?? 'unknown';
    const pluginMeta = (edge.metadata as Record<string, unknown> | undefined);
    const plugin = pluginMeta?.plugin as string | undefined;
    const by = plugin ? ` by ${plugin}` : '';
    lines.push(`- **Schedule:** ${schedName}${by}${edge.line ? ` (line ${edge.line})` : ''}`);
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

// =============================================================================
// classifyMutability — Bevy wrapper type detection
// =============================================================================

export function classifyMutability(signature: string | undefined | null, typeName: string): 'mut' | 'shared' | 'owning' | 'unknown' {
  if (!signature) return 'unknown';
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode-aware word boundary: JS \b only matches ASCII [a-zA-Z0-9_],
  // so CJK type names never match. Use lookaround instead.
  const WB = `(?<![\\p{L}\\p{N}_])`;
  const WE = `(?![\\p{L}\\p{N}_])`;

  // Mutable: ResMut<Type>, &mut Type
  const NESTED = `(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*`;
  if (new RegExp(`ResMut\\s*<${NESTED}${WB}${escaped}${WE}`, 'u').test(signature)) return 'mut';
  if (new RegExp(`&mut\\s+${WB}${escaped}${WE}`, 'u').test(signature)) return 'mut';

  // Shared: Res<Type> (but not ResMut), &Type (but not &mut)
  if (new RegExp(`(?<!Mut)Res\\s*<${NESTED}${WB}${escaped}${WE}`, 'u').test(signature)) return 'shared';
  if (new RegExp(`(?<!&mut\\s)&${WB}${escaped}${WE}`, 'u').test(signature)) return 'shared';

  // Owned: return type or plain param without &
  if (new RegExp(`->\\s*[^;{]*${WB}${escaped}${WE}`, 'u').test(signature)) return 'owning';
  if (new RegExp(`${WB}${escaped}${WE}`, 'u').test(signature)) return 'owning';

  return 'unknown';
}

// =============================================================================
// Bevy edge risk classification
// =============================================================================

const BEVY_HIGH_RISK_KINDS = new Set(['on_enter', 'on_exit', 'on_transition']);
const BEVY_MEDIUM_RISK_KINDS = new Set([
  'runs_in', 'registers_resource', 'registers_message',
  'contains_plugin', 'registers_system',
]);

export function classifyBevyEdgeRisk(kind: string): 'high' | 'medium' | 'low' | null {
  if (BEVY_HIGH_RISK_KINDS.has(kind)) return 'high';
  if (BEVY_MEDIUM_RISK_KINDS.has(kind)) return 'medium';
  return null;
}
