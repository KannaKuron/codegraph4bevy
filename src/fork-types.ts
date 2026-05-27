/**
 * Fork-specific EdgeKind extensions.
 *
 * Upstream types.ts defines UpstreamEdgeKind for the standard edge types.
 * This file defines the fork-specific additions (Bevy ECS, Rust patterns).
 * Separating them makes upstream types.ts changes merge cleanly.
 */

export const FORK_EDGE_KINDS = {
  patternMatch: 'pattern_match',
  macroCall: 'macro_call',
  methodCall: 'method_call',
  registersSystem: 'registers_system',
  runsIn: 'runs_in',
  registersResource: 'registers_resource',
  registersMessage: 'registers_message',
  containsPlugin: 'contains_plugin',
  onEnter: 'on_enter',
  onExit: 'on_exit',
  onTransition: 'on_transition',
} as const;

export type ForkEdgeKind = (typeof FORK_EDGE_KINDS)[keyof typeof FORK_EDGE_KINDS];

/** Bevy-specific edge kinds (synthesizer output) */
export const BEVY_EDGE_KINDS = new Set<string>([
  'registers_system',
  'runs_in',
  'registers_resource',
  'registers_message',
  'contains_plugin',
  'on_enter',
  'on_exit',
  'on_transition',
]);
