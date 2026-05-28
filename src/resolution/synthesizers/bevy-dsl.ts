/**
 * Bevy DSL semantic edge synthesizer (N12).
 *
 * Scans Plugin/PluginGroup `build()` method bodies for
 * add_systems, init_resource, add_message, and PluginGroup::build
 * patterns, creating structured edges (on_enter, on_exit, runs_in,
 * registers_resource, registers_message, contains_plugin) that
 * static tree-sitter extraction treats as opaque calls.
 */
import type { Edge, Node } from '../../types';
import type { QueryBuilder } from '../../db/queries';
import type { ResolutionContext } from '../types';
import { stripRustComments, extractBlock, resolveNode, parseHandlerNames, splitTopLevelCommas } from './bevy-utils';

const WELL_KNOWN_SCHEDULES = new Set([
  'Update', 'FixedUpdate', 'PreUpdate', 'PostUpdate',
  'Startup', 'PostStartup', 'First', 'Last',
  'PreStartup', 'FixedPreUpdate', 'FixedPostUpdate',
  'FixedFirst', 'FixedLast', 'RunOnce',
]);

// =============================================================================
// parseAddSystems
// =============================================================================

function parseAddSystems(
  buildBody: string,
  pluginNode: Node,
  file: string,
  lineOffset: number,
  ctx: ResolutionContext,
  seen: Set<string>,
): { edges: Edge[]; syntheticNodes: Node[] } {
  const edges: Edge[] = [];
  const syntheticNodes: Node[] = [];
  const re = /\.add_systems\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(buildBody))) {
    const open = m.index + m[0].length;
    let depth = 0;
    let close = -1;
    for (let i = open - 1; i < buildBody.length; i++) {
      if (buildBody[i] === '(') depth++;
      else if (buildBody[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    const argsStr = buildBody.slice(open, close);
    const args = splitTopLevelCommas(argsStr);
    if (args.length < 2) continue;

    const scheduleArg = args[0]!.trim();
    const handlerArg = args.slice(1).join(',');

    let scheduleName: string | null = null;
    const onEnterMatch = /^OnEnter\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)$/u.exec(scheduleArg);
    const onExitMatch = /^OnExit\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)$/u.exec(scheduleArg);
    const onTransitionMatch = /^OnTransition\s*::\s*<\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*,\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*>$/u.exec(scheduleArg);

    if (onEnterMatch || onExitMatch) {
      const stateName = (onEnterMatch ?? onExitMatch)![1]!.replace(/\s+/g, '');
      const edgeKind: 'on_enter' | 'on_exit' = onEnterMatch ? 'on_enter' : 'on_exit';
      const variantName = stateName.split('::').pop() ?? stateName;
      const allVariantNodes = ctx.getNodesByName(variantName);
      const stateNodes = allVariantNodes.filter(n =>
        n.kind === 'enum_member' && n.qualifiedName === stateName,
      );
      const effectiveStateNodes = stateNodes.length > 0
        ? stateNodes
        : allVariantNodes.filter(n => n.kind === 'enum_member');

      const handlerNames = parseHandlerNames(handlerArg);
      for (const hName of handlerNames) {
        const handlerNode = resolveNode(hName, file, ctx);
        if (!handlerNode) continue;

        const rsKey = `${pluginNode.id}>${handlerNode.id}>registers_system>${scheduleArg.replace(/\s+/g, '')}`;
        if (!seen.has(rsKey)) {
          seen.add(rsKey);
          const rsLine = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: pluginNode.id,
            target: handlerNode.id,
            kind: 'registers_system',
            line: rsLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', schedule: scheduleArg.replace(/\s+/g, '') },
          });
        }

        for (const sn of effectiveStateNodes) {
          const key = `${handlerNode.id}>${sn.id}>${edgeKind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: handlerNode.id,
            target: sn.id,
            kind: edgeKind,
            line,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', plugin: pluginNode.name },
          });
        }
      }
    } else if (onTransitionMatch) {
      const fromStateFull = onTransitionMatch[1]!.replace(/\s+/g, '');
      const toStateFull = onTransitionMatch[2]!.replace(/\s+/g, '');
      const fromVariant = fromStateFull.split('::').pop() ?? fromStateFull;
      const toVariant = toStateFull.split('::').pop() ?? toStateFull;

      const fromStateNodes = ctx.getNodesByName(fromVariant).filter(n =>
        n.kind === 'enum_member' && (n.qualifiedName === fromStateFull || n.qualifiedName.endsWith('::' + fromVariant)),
      );
      const toStateNodes = ctx.getNodesByName(toVariant).filter(n =>
        n.kind === 'enum_member' && (n.qualifiedName === toStateFull || n.qualifiedName.endsWith('::' + toVariant)),
      );
      const effectiveFromNodes = fromStateNodes.length > 0 ? fromStateNodes : ctx.getNodesByName(fromVariant).filter(n => n.kind === 'enum_member');
      const effectiveToNodes = toStateNodes.length > 0 ? toStateNodes : ctx.getNodesByName(toVariant).filter(n => n.kind === 'enum_member');

      const handlerNames = parseHandlerNames(handlerArg);
      for (const hName of handlerNames) {
        const handlerNode = resolveNode(hName, file, ctx);
        if (!handlerNode) continue;

        const rsKey = `${pluginNode.id}>${handlerNode.id}>registers_system>${scheduleArg.replace(/\s+/g, '')}`;
        if (!seen.has(rsKey)) {
          seen.add(rsKey);
          const rsLine = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: pluginNode.id,
            target: handlerNode.id,
            kind: 'registers_system',
            line: rsLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', schedule: scheduleArg.replace(/\s+/g, '') },
          });
        }

        for (const sn of effectiveFromNodes) {
          const key = `${handlerNode.id}>${sn.id}>on_transition>from`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: handlerNode.id,
            target: sn.id,
            kind: 'on_transition',
            line,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', plugin: pluginNode.name, transitionFrom: fromStateFull, transitionTo: toStateFull },
          });
        }
        for (const sn of effectiveToNodes) {
          const key = `${handlerNode.id}>${sn.id}>on_transition>to`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: handlerNode.id,
            target: sn.id,
            kind: 'on_transition',
            line,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', plugin: pluginNode.name, transitionFrom: fromStateFull, transitionTo: toStateFull },
          });
        }
      }
    } else {
      const sched = scheduleArg.split('::').pop()!;
      scheduleName = WELL_KNOWN_SCHEDULES.has(sched) ? sched : scheduleArg;

      const schedNodeId = `bevy-schedule-${scheduleName}`;
      syntheticNodes.push({
        id: schedNodeId,
        name: scheduleName,
        kind: 'variable',
        qualifiedName: scheduleName,
        filePath: pluginNode.filePath,
        language: 'rust',
        startLine: 0, endLine: 0,
        startColumn: 0, endColumn: 0,
        updatedAt: Date.now(),
      });

      const handlerNames = parseHandlerNames(handlerArg);
      for (const hName of handlerNames) {
        const handlerNode = resolveNode(hName, file, ctx);
        if (!handlerNode) continue;

        const rsKey = `${pluginNode.id}>${handlerNode.id}>registers_system>${scheduleName}`;
        if (!seen.has(rsKey)) {
          seen.add(rsKey);
          const rsLine = lineOffset + buildBody.slice(0, m.index).split('\n').length;
          edges.push({
            source: pluginNode.id,
            target: handlerNode.id,
            kind: 'registers_system',
            line: rsLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'bevy-dsl', schedule: scheduleName },
          });
        }

        const key = `${handlerNode.id}>${schedNodeId}>runs_in`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
        edges.push({
          source: handlerNode.id,
          target: schedNodeId,
          kind: 'runs_in',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-dsl', plugin: pluginNode.name },
        });
      }
    }
  }
  return { edges, syntheticNodes };
}

// =============================================================================
// parseInitResource
// =============================================================================

function parseInitResource(
  buildBody: string,
  pluginNode: Node,
  ctx: ResolutionContext,
  seen: Set<string>,
  lineOffset: number,
): Edge[] {
  const edges: Edge[] = [];
  const re = /\.init_resource\s*::\s*<\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*>/gu;
  let m: RegExpExecArray | null;

  while ((m = re.exec(buildBody))) {
    const typeName = m[1]!.replace(/\s+/g, '');
    const resNodes = ctx.getNodesByName(typeName);
    for (const rn of resNodes) {
      if (rn.kind !== 'struct' && rn.kind !== 'enum') continue;
      const key = `${pluginNode.id}>${rn.id}>registers_resource`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
      edges.push({
        source: pluginNode.id,
        target: rn.id,
        kind: 'registers_resource',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'bevy-dsl' },
      });
    }
  }
  return edges;
}

// =============================================================================
// parseAddMessage
// =============================================================================

function parseAddMessage(
  buildBody: string,
  pluginNode: Node,
  ctx: ResolutionContext,
  seen: Set<string>,
  lineOffset: number,
): Edge[] {
  const edges: Edge[] = [];
  const re = /\.add_message\s*::\s*<\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*>/gu;
  let m: RegExpExecArray | null;

  while ((m = re.exec(buildBody))) {
    const typeName = m[1]!.replace(/\s+/g, '');
    const msgNodes = ctx.getNodesByName(typeName);
    for (const mn of msgNodes) {
      if (mn.kind !== 'struct' && mn.kind !== 'enum') continue;
      const key = `${pluginNode.id}>${mn.id}>registers_message`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
      edges.push({
        source: pluginNode.id,
        target: mn.id,
        kind: 'registers_message',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'bevy-dsl' },
      });
    }
  }
  return edges;
}

// =============================================================================
// parsePluginGroupBuild
// =============================================================================

function parsePluginGroupBuild(
  buildBody: string,
  groupNode: Node,
  ctx: ResolutionContext,
  seen: Set<string>,
  lineOffset: number,
): Edge[] {
  const edges: Edge[] = [];
  const re = /\.add\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
  let m: RegExpExecArray | null;

  while ((m = re.exec(buildBody))) {
    const typeName = m[1]!.replace(/\s+/g, '');
    let pluginNodes = ctx.getNodesByName(typeName).filter(n => n.kind === 'struct');
    if (pluginNodes.length === 0) {
      const lastSeg = typeName.split('::').pop() ?? typeName;
      if (lastSeg !== typeName) {
        pluginNodes = ctx.getNodesByName(lastSeg).filter(n => n.kind === 'struct');
      }
    }
    for (const pn of pluginNodes) {
      const key = `${groupNode.id}>${pn.id}>contains_plugin`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOffset + buildBody.slice(0, m.index).split('\n').length;
      edges.push({
        source: groupNode.id,
        target: pn.id,
        kind: 'contains_plugin',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'bevy-dsl' },
      });
    }
  }
  return edges;
}

// =============================================================================
// bevyDslEdges (main entry)
// =============================================================================

export function bevyDslEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const allSyntheticNodes: Node[] = [];
  const seen = new Set<string>();

  const IMPL_RE = /impl\s+(Plugin(?:Group)?)\s+for\s+([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)/gu;

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const raw = ctx.readFile(file);
    if (!raw) continue;
    const content = stripRustComments(raw);

    IMPL_RE.lastIndex = 0;
    let implMatch: RegExpExecArray | null;
    while ((implMatch = IMPL_RE.exec(content))) {
      const traitName = implMatch[1]!;
      const structName = implMatch[2]!;
      const structNode = resolveNode(structName, file, ctx);
      if (!structNode) continue;

      const implOpen = content.indexOf('{', implMatch.index);
      if (implOpen < 0) continue;
      const implBody = extractBlock(content, implOpen);
      if (!implBody) continue;

      const buildRe = /fn\s+build\s*\([^)]*\)\s*(?:->\s*[^{]+)?\s*\{/g;
      buildRe.lastIndex = 0;
      let buildMatch: RegExpExecArray | null;
      while ((buildMatch = buildRe.exec(implBody))) {
        const buildOpen = implBody.indexOf('{', buildMatch.index);
        if (buildOpen < 0) continue;
        const buildBody = extractBlock(implBody, buildOpen);
        if (!buildBody) continue;

        const implStartLine = content.slice(0, implOpen).split('\n').length;
        const buildStartLine = implBody.slice(0, buildOpen).split('\n').length;
        const lineOffset = implStartLine + buildStartLine - 1;

        if (traitName === 'Plugin') {
          const addSystemsResult = parseAddSystems(buildBody, structNode, file, lineOffset, ctx, seen);
          edges.push(...addSystemsResult.edges);
          allSyntheticNodes.push(...addSystemsResult.syntheticNodes);
          edges.push(...parseInitResource(buildBody, structNode, ctx, seen, lineOffset));
          edges.push(...parseAddMessage(buildBody, structNode, ctx, seen, lineOffset));
        } else {
          edges.push(...parsePluginGroupBuild(buildBody, structNode, ctx, seen, lineOffset));
        }
      }
    }
  }

  if (allSyntheticNodes.length > 0) {
    try { queries.insertNodes(allSyntheticNodes); } catch { /* duplicates — safe to ignore */ }
  }

  return edges;
}
