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
// Issue #9: Bevy Widget structured overview constants
// =============================================================================

const BEVY_DSL_KINDS: Edge['kind'][] = [
  'registers_observer', 'registers_system', 'registers_resource',
  'registers_message', 'registers_state', 'contains_plugin',
  'configures_set', 'registers_type', 'registers_non_send',
];
const LIFECYCLE_HOOKS = new Set(['Add', 'Insert', 'Remove', 'Replace', 'Despawn']);
const MAX_PER_GROUP = 15;

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

  if (m?.synthesizedBy === 'bevy-ecs-message') {
    return {
      label: `Bevy message dataflow — message producer triggers consumer via on_message (dynamic dispatch)`,
      compact: `dynamic: Bevy message dataflow${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'bevy-ecs-observer') {
    return {
      label: `Bevy observer dataflow — trigger producer reaches observer handler (dynamic dispatch)`,
      compact: `dynamic: Bevy observer dataflow${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'bevy-relationship') {
    return {
      label: `Bevy relationship — component pair linked via #[relationship] attribute`,
      compact: `static: Bevy relationship${at}`,
      registeredAt,
    };
  }
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
      case 'registers_observer':
        return {
          label: `Bevy observer — plugin registers observer (dynamic dispatch)`,
          compact: `dynamic: register observer${at}`,
          registeredAt,
        };
      case 'configures_set':
        return {
          label: `Bevy system set — plugin configures a system set (dynamic dispatch)`,
          compact: `dynamic: configure set${at}`,
          registeredAt,
        };
      case 'registers_type':
        return {
          label: `Bevy type registration — plugin registers type for reflection (dynamic dispatch)`,
          compact: `dynamic: register type${at}`,
          registeredAt,
        };
      case 'registers_non_send':
        return {
          label: `Bevy non-send resource — plugin registers non-Send resource (dynamic dispatch)`,
          compact: `dynamic: register non-send${at}`,
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
  'contains_plugin', 'registers_system', 'registers_observer',
  'configures_set', 'registers_type', 'registers_non_send',
]);

export function classifyBevyEdgeRisk(kind: string): 'high' | 'medium' | 'low' | null {
  if (BEVY_HIGH_RISK_KINDS.has(kind)) return 'high';
  if (BEVY_MEDIUM_RISK_KINDS.has(kind)) return 'medium';
  return null;
}

// =============================================================================
// Issue #9: Bevy Widget structured overview for codegraph_symbol_info
// =============================================================================

function isLifecycleEvent(name: string): boolean {
  if (LIFECYCLE_HOOKS.has(name)) return true;
  if (name.startsWith('On') && LIFECYCLE_HOOKS.has(name.slice(2))) return true;
  return false;
}

function extractBracketContent(s: string, start: number): string {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') {
      depth--;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return '';
}

/**
 * Check whether a node is a Bevy Plugin struct with synthesized DSL outgoing edges.
 * This gates the structured widget overview — only structs that register systems,
 * observers, resources, etc. get the special formatting.
 */
export function isBevyPluginStruct(cg: CodeGraph, node: Node): boolean {
  if (node.kind !== 'struct') return false;
  const outgoing = cg.getOutgoingEdges(node.id);
  return outgoing.some(e => {
    const m = e.metadata as Record<string, unknown> | undefined;
    return m?.synthesizedBy === 'bevy-dsl' && (BEVY_DSL_KINDS as string[]).includes(e.kind);
  });
}

/**
 * Extract the trigger event type from a Bevy observer handler signature.
 *
 * Handles three patterns:
 *   1. Trigger<On<Event>>   →  "On<Event>"
 *   2. Trigger<E>           →  "Trigger<E>"
 *   3. On<E>                →  "On<E>"
 *
 * Returns null for lifecycle hooks (OnAdd, OnInsert, etc.)
 * and signatures that don't match any observer pattern.
 */
export function extractObserverEventType(signature: string): string | null {
  // Pattern 1 & 2: Trigger<...>
  const triggerIdx = signature.indexOf('Trigger<');
  if (triggerIdx >= 0) {
    const inner = extractBracketContent(signature, triggerIdx + 7);
    if (!inner) return null;

    // Trigger<On<Event>> → On<Event>
    if (inner.startsWith('On<')) {
      const onInner = extractBracketContent(inner, 2);
      if (!onInner) return null;
      const firstName = onInner.split(/[,<]/)[0]!.trim();
      if (isLifecycleEvent(firstName)) return null;
      return `On<${onInner}>`;
    }

    // Trigger<E> — direct event
    const firstName = inner.split(/[,<]/)[0]!.trim();
    if (isLifecycleEvent(firstName)) return null;
    return `Trigger<${inner}>`;
  }

  // Pattern 3: Standalone On<E>
  const onIdx = signature.indexOf('On<');
  if (onIdx >= 0) {
    const onInner = extractBracketContent(signature, onIdx + 2);
    if (!onInner) return null;
    const firstName = onInner.split(/[,<]/)[0]!.trim();
    if (isLifecycleEvent(firstName)) return null;
    return `On<${onInner}>`;
  }

  return null;
}

/**
 * Format a structured overview of a Bevy Plugin struct for codegraph_symbol_info.
 *
 * Groups outgoing synthesized edges by kind and renders tables/lists:
 *   registers_observer → Observers (Handler | Trigger Event | Location)
 *   registers_system   → Systems   (System | Schedule | Location)
 *   registers_resource → Resources (Resource | Method)
 *   registers_message  → Messages  (list)
 *   registers_state    → States    (State | Method)
 *   contains_plugin    → Dependencies (list)
 *
 * Returns null if the node has no relevant bevy-dsl edges.
 */
export function formatBevyWidgetOverview(cg: CodeGraph, node: Node): string | null {
  const outgoing = cg.getOutgoingEdges(node.id).filter(e => {
    const m = e.metadata as Record<string, unknown> | undefined;
    return m?.synthesizedBy === 'bevy-dsl' && (BEVY_DSL_KINDS as string[]).includes(e.kind);
  });
  if (outgoing.length === 0) return null;

  const byKind = new Map<string, Edge[]>();
  for (const e of outgoing) {
    const arr = byKind.get(e.kind) || [];
    arr.push(e);
    byKind.set(e.kind, arr);
  }

  const lines: string[] = [];
  lines.push(`### ${node.name} — Bevy Widget`);
  lines.push('');
  lines.push(`- **定义**: \`${node.filePath}:${node.startLine}\``);
  lines.push(`- **实现**: Plugin`);
  lines.push('');

  // Observers table
  const observers = byKind.get('registers_observer');
  if (observers && observers.length > 0) {
    lines.push(`#### Observers (${observers.length})`);
    lines.push('');
    lines.push('| Handler | Trigger Event | Location |');
    lines.push('|---------|--------------|----------|');
    const shown = observers.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      const event = extractObserverEventType(target.signature ?? '') ?? '—';
      lines.push(`| \`${target.name}\` | ${event} | \`${target.filePath}:${target.startLine}\` |`);
    }
    if (observers.length > MAX_PER_GROUP) {
      lines.push(`| … and ${observers.length - MAX_PER_GROUP} more |||`);
    }
    lines.push('');
  }

  // Systems table
  const systems = byKind.get('registers_system');
  if (systems && systems.length > 0) {
    lines.push(`#### Systems (${systems.length})`);
    lines.push('');
    lines.push('| System | Schedule | Location |');
    lines.push('|--------|---------|----------|');
    const shown = systems.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      const m = e.metadata as Record<string, unknown> | undefined;
      const schedule = typeof m?.schedule === 'string' ? m.schedule : 'unknown';
      lines.push(`| \`${target.name}\` | ${schedule} | \`${target.filePath}:${target.startLine}\` |`);
    }
    if (systems.length > MAX_PER_GROUP) {
      lines.push(`| … and ${systems.length - MAX_PER_GROUP} more |||`);
    }
    lines.push('');
  }

  // Resources table
  const resources = byKind.get('registers_resource');
  if (resources && resources.length > 0) {
    lines.push(`#### Resources (${resources.length})`);
    lines.push('');
    lines.push('| Resource | Method |');
    lines.push('|---------|--------|');
    const shown = resources.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`| \`${target.name}\` | init_resource |`);
    }
    if (resources.length > MAX_PER_GROUP) {
      lines.push(`| … and ${resources.length - MAX_PER_GROUP} more ||`);
    }
    lines.push('');
  }

  // Types table (registers_type)
  const types = byKind.get('registers_type');
  if (types && types.length > 0) {
    lines.push(`#### Types (${types.length})`);
    lines.push('');
    lines.push('| Type | Method |');
    lines.push('|-------|--------|');
    const shown = types.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`| \`${target.name}\` | register_type |`);
    }
    if (types.length > MAX_PER_GROUP) {
      lines.push(`| … and ${types.length - MAX_PER_GROUP} more ||`);
    }
    lines.push('');
  }

  // Non-Send Resources table (registers_non_send)
  const nonSend = byKind.get('registers_non_send');
  if (nonSend && nonSend.length > 0) {
    lines.push(`#### Non-Send Resources (${nonSend.length})`);
    lines.push('');
    lines.push('| Resource | Method |');
    lines.push('|---------|--------|');
    const shown = nonSend.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`| \`${target.name}\` | init_non_send |`);
    }
    if (nonSend.length > MAX_PER_GROUP) {
      lines.push(`| … and ${nonSend.length - MAX_PER_GROUP} more ||`);
    }
    lines.push('');
  }

  // Messages list
  const messages = byKind.get('registers_message');
  if (messages && messages.length > 0) {
    lines.push(`#### Messages (${messages.length})`);
    lines.push('');
    const shown = messages.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`- \`${target.name}\` (\`${target.filePath}:${target.startLine}\`)`);
    }
    if (messages.length > MAX_PER_GROUP) {
      lines.push(`  … and ${messages.length - MAX_PER_GROUP} more`);
    }
    lines.push('');
  }

  // States table
  const states = byKind.get('registers_state');
  if (states && states.length > 0) {
    lines.push(`#### States (${states.length})`);
    lines.push('');
    lines.push('| State | Method |');
    lines.push('|--------|--------|');
    const shown = states.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      const m = e.metadata as Record<string, unknown> | undefined;
      const method = typeof m?.method === 'string' ? m.method : 'init_state';
      lines.push(`| \`${target.name}\` | ${method} |`);
    }
    if (states.length > MAX_PER_GROUP) {
      lines.push(`| … and ${states.length - MAX_PER_GROUP} more ||`);
    }
    lines.push('');
  }

  // System Sets list
  const systemSets = byKind.get('configures_set');
  if (systemSets && systemSets.length > 0) {
    lines.push(`#### System Sets (${systemSets.length})`);
    lines.push('');
    const shown = systemSets.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`- \`${target.name}\` (configures_set)`);
    }
    if (systemSets.length > MAX_PER_GROUP) {
      lines.push(`  … and ${systemSets.length - MAX_PER_GROUP} more`);
    }
    lines.push('');
  }

  // Dependencies list
  const deps = byKind.get('contains_plugin');
  if (deps && deps.length > 0) {
    lines.push(`#### Dependencies`);
    lines.push('');
    const shown = deps.slice(0, MAX_PER_GROUP);
    for (const e of shown) {
      const target = cg.getNode(e.target);
      if (!target) continue;
      lines.push(`- \`${target.name}\` (contains_plugin)`);
    }
    if (deps.length > MAX_PER_GROUP) {
      lines.push(`  … and ${deps.length - MAX_PER_GROUP} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
