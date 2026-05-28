/**
 * Bevy ECS state transition synthesizer.
 *
 * Bridges dynamic dispatch holes in Bevy state transitions:
 *   - NextState::Pending(X) producers → in_state(X) consumers
 *   - OnEnter/OnExit handler registration → state variant enum_member nodes
 *   - ComputedStates transitive edges via intermediate state struct/enum nodes
 *   - SubStates virtual producers
 */
import type { Edge } from '../../types';
import type { ResolutionContext } from '../types';
import { stripRustComments, parseHandlerNames } from './bevy-utils';

const NEXT_STATE_PENDING_RE = /NextState\s*::\s*Pending\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
const NEXT_STATE_SET_RE = /[\p{L}\p{N}_]+\s*\.\s*set\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
const IN_STATE_RE = /in_state\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
const IMPL_HEADER_RE = /impl\s+ComputedStates\s+for\s+([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)(?:\s+where\s+[^{]+)?\s*\{/gu;
const ADD_SYSTEMS_ONENTEREXIT_RE = /\.add_systems\s*\(\s*(OnEnter|OnExit)\s*\(/g;
const ADD_SYSTEMS_ONTRANSITION_RE = /\.add_systems\s*\(\s*OnTransition\s*\{\s*exited\s*:\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*,\s*entered\s*:\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\}/gu;
const SUBSTATES_SOURCE_RE = /#\[\s*source\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*=\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)\s*\]\s*(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([\p{L}\p{N}_]+)\s*\{/gu;
const DEFAULT_VARIANT_RE = /#\[\s*default\s*\]\s*([\p{L}\p{N}_]+)/gu;

interface SubStatesMapping {
  subStateName: string;
  parentVariantFull: string;
  defaultVariant: string;
}

/** Angle-bracket-aware comma splitter for tuple SourceTypes. */
function splitTypeList(spec: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i]!;
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      const part = spec.slice(start, i).trim();
      if (part) results.push(part);
      start = i + 1;
    }
  }
  const last = spec.slice(start).trim();
  if (last) results.push(last);
  return results;
}

/** Extract ComputedStates impl→SourceStates mapping from stripped Rust source. */
function extractComputedStatesSources(content: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  IMPL_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPL_HEADER_RE.exec(content))) {
    const computedNameRaw = m[1]!.replace(/\s+/g, '');
    const computedParts = computedNameRaw.split('::').filter(p => p.length > 0);
    const computedName = computedParts[computedParts.length - 1] ?? computedNameRaw;
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    IMPL_HEADER_RE.lastIndex = i;
    const body = content.slice(bodyStart, i - 1);
    const sourceMatch = body.match(/type\s+SourceStates\s*=\s*([^;]+);/);
    if (!sourceMatch) continue;
    const sourceSpec = sourceMatch[1]!.trim();
    const sourceTypes = sourceSpec.startsWith('(')
      ? splitTypeList(sourceSpec.slice(1, -1))
      : [sourceSpec];
    for (const src of sourceTypes) {
      const srcRaw = src.replace(/\s+/g, '');
      const srcParts = srcRaw.split('::').filter(p => p.length > 0);
      const srcShort = srcParts[srcParts.length - 1] ?? srcRaw;
      let arr = result.get(srcShort);
      if (!arr) { arr = []; result.set(srcShort, arr); }
      if (!arr.includes(computedName)) arr.push(computedName);
    }
  }
  return result;
}

/** Extract SubStates #[source(...)] + #[default] variant from stripped Rust source. */
function extractSubStatesSources(content: string): SubStatesMapping[] {
  const results: SubStatesMapping[] = [];
  SUBSTATES_SOURCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUBSTATES_SOURCE_RE.exec(content))) {
    const parentTypeRaw = m[1]!.replace(/\s+/g, '');
    const parentVariantRaw = m[2]!.replace(/\s+/g, '');
    const subStateName = m[3]!;
    const parentTypeShort = parentTypeRaw.split('::').filter(p => p.length > 0).pop() ?? parentTypeRaw;
    const parentVariantParts = parentVariantRaw.split('::').filter(p => p.length > 0);
    let qualifyingVariant: string;
    if (parentVariantParts.length >= 2) {
      qualifyingVariant = parentVariantParts[parentVariantParts.length - 1]!;
    } else {
      qualifyingVariant = parentVariantParts[0]!;
    }
    const parentVariantFull = parentTypeShort + '::' + qualifyingVariant;

    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    SUBSTATES_SOURCE_RE.lastIndex = i;
    const body = content.slice(bodyStart, i - 1);

    DEFAULT_VARIANT_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = DEFAULT_VARIANT_RE.exec(body))) {
      results.push({
        subStateName,
        parentVariantFull,
        defaultVariant: dm[1]!,
      });
      break;
    }
  }
  return results;
}

export function bevyStateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const states = new Map<string, { producers: Map<string, { line: number; full: string }>; consumers: Map<string, { line: number; full: string }> }>();

  function ensure(s: string) {
    if (!states.has(s)) states.set(s, { producers: new Map(), consumers: new Map() });
    return states.get(s)!;
  }

  function normalizeStateName(name: string): { full: string; variant: string } {
    const parts = name.split('::').filter(p => p.length > 0);
    const variant = parts[parts.length - 1] ?? name;
    const full = parts.length >= 2
      ? parts[parts.length - 2]! + '::' + variant
      : variant;
    return { full, variant };
  }

  const strippedByFile = new Map<string, string>();

  // Pre-scan: ComputedStates
  const computedFromSource = new Map<string, string[]>();
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const raw = ctx.readFile(file);
    if (!raw) continue;
    const content = stripRustComments(raw);
    strippedByFile.set(file, content);
    for (const [src, names] of extractComputedStatesSources(content)) {
      const arr = computedFromSource.get(src);
      if (arr) {
        for (const n of names) { if (!arr.includes(n)) arr.push(n); }
      } else {
        computedFromSource.set(src, [...names]);
      }
    }
  }

  // Pre-scan: SubStates
  const subStatesMappings: SubStatesMapping[] = [];
  for (const [, content] of strippedByFile) {
    subStatesMappings.push(...extractSubStatesSources(content));
  }

  // Main scan: find producers and consumers
  for (const [file, content] of strippedByFile) {
    const fileNodes = ctx.getNodesInFile(file);
    const fns = fileNodes.filter((n: { kind: string }) => n.kind === 'function' || n.kind === 'method');

    function findEnclosingFn(line: number): string | null {
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) return fn.id;
      }
      return null;
    }

    // Producers: NextState::Pending(X)
    NEXT_STATE_PENDING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NEXT_STATE_PENDING_RE.exec(content))) {
      const { full, variant } = normalizeStateName(m[1]!.trim());
      const line = content.substring(0, m.index).split('\n').length;
      const fnId = findEnclosingFn(line);
      if (fnId) {
        const entry = ensure(variant);
        entry.producers.set(fnId + '\0' + full, { line, full });
      }
    }

    // Producers: .set(X)
    if (content.includes('NextState')) {
      NEXT_STATE_SET_RE.lastIndex = 0;
      while ((m = NEXT_STATE_SET_RE.exec(content))) {
        const { full, variant } = normalizeStateName(m[1]!.trim());
        const line = content.substring(0, m.index).split('\n').length;
        const fnId = findEnclosingFn(line);
        if (fnId) {
          const entry = ensure(variant);
          entry.producers.set(fnId + '\0' + full, { line, full });
        }
      }
    }

    // Consumers: in_state(X)
    IN_STATE_RE.lastIndex = 0;
    while ((m = IN_STATE_RE.exec(content))) {
      const { full, variant } = normalizeStateName(m[1]!.trim());
      const line = content.substring(0, m.index).split('\n').length;
      const fnId = findEnclosingFn(line);
      if (fnId) {
        const entry = ensure(variant);
        entry.consumers.set(fnId + '\0' + full, { line, full });
      }
    }
  }

  // Phase 2b: OnEnter/OnExit consumer detection
  for (const [file, content] of strippedByFile) {
    const fileNodes = ctx.getNodesInFile(file);
    const fnByName = new Map<string, typeof fileNodes[number]>();
    for (const n of fileNodes) {
      if ((n.kind === 'function' || n.kind === 'method') && n.name) {
        if (!fnByName.has(n.name)) fnByName.set(n.name, n);
      }
    }
    ADD_SYSTEMS_ONENTEREXIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ADD_SYSTEMS_ONENTEREXIT_RE.exec(content))) {
      const onOpen = m.index + m[0].length;
      let onDepth = 0;
      let onClose = -1;
      for (let i = onOpen; i < content.length; i++) {
        if (content[i] === '(') onDepth++;
        else if (content[i] === ')') {
          if (onDepth === 0) { onClose = i; break; }
          onDepth--;
        }
      }
      if (onClose < 0) continue;
      const stateRaw = content.slice(onOpen, onClose).trim();
      const { full, variant } = normalizeStateName(stateRaw);
      let comma = -1;
      for (let i = onClose + 1; i < content.length; i++) {
        if (content[i] === ',') { comma = i; break; }
        if (content[i] !== ' ' && content[i] !== '\t' && content[i] !== '\n') break;
      }
      if (comma < 0) continue;
      const addSysOpen = content.indexOf('(', m.index);
      if (addSysOpen < 0) continue;
      let addSysDepth = 0;
      let addSysClose = -1;
      for (let i = addSysOpen; i < content.length; i++) {
        if (content[i] === '(') addSysDepth++;
        else if (content[i] === ')') { addSysDepth--; if (addSysDepth === 0) { addSysClose = i; break; } }
      }
      if (addSysClose < 0) continue;
      const handlerArg = content.slice(comma + 1, addSysClose);
      const handlerNames = parseHandlerNames(handlerArg);
      const lineBase = content.substring(0, m.index).split('\n').length;
      for (const hName of handlerNames) {
        let handlerNode = fnByName.get(hName);
        if (!handlerNode) {
          const globalNodes = ctx.getNodesByName(hName);
          handlerNode = globalNodes.length > 0 ? globalNodes[0] : undefined;
        }
        if (!handlerNode) continue;
        const entry = ensure(variant);
        entry.consumers.set(handlerNode.id + '\0' + full, { line: lineBase, full });
      }
    }
  }

  // Phase 2b OnTransition
  for (const [file, content] of strippedByFile) {
    const fileNodes = ctx.getNodesInFile(file);
    const fnByName = new Map<string, typeof fileNodes[number]>();
    for (const n of fileNodes) {
      if ((n.kind === 'function' || n.kind === 'method') && n.name) {
        if (!fnByName.has(n.name)) fnByName.set(n.name, n);
      }
    }
    ADD_SYSTEMS_ONTRANSITION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ADD_SYSTEMS_ONTRANSITION_RE.exec(content))) {
      const toStateFull = m[2]!.replace(/\s+/g, '');
      const { full, variant } = normalizeStateName(toStateFull);
      const braceClose = content.indexOf('}', m.index + m[0].length - 1);
      if (braceClose < 0) continue;
      let comma = -1;
      for (let i = braceClose + 1; i < content.length; i++) {
        if (content[i] === ',') { comma = i; break; }
        if (content[i] !== ' ' && content[i] !== '\t' && content[i] !== '\n') break;
      }
      if (comma < 0) continue;
      const addSysOpen = content.indexOf('(', m.index);
      if (addSysOpen < 0) continue;
      let addSysDepth = 0;
      let addSysClose = -1;
      for (let i = addSysOpen; i < content.length; i++) {
        if (content[i] === '(') addSysDepth++;
        else if (content[i] === ')') { addSysDepth--; if (addSysDepth === 0) { addSysClose = i; break; } }
      }
      if (addSysClose < 0) continue;
      const handlerArg = content.slice(comma + 1, addSysClose);
      const handlerNames = parseHandlerNames(handlerArg);
      const lineBase = content.substring(0, m.index).split('\n').length;
      for (const hName of handlerNames) {
        let handlerNode = fnByName.get(hName);
        if (!handlerNode) {
          const globalNodes = ctx.getNodesByName(hName);
          handlerNode = globalNodes.length > 0 ? globalNodes[0] : undefined;
        }
        if (!handlerNode) continue;
        const entry = ensure(variant);
        entry.consumers.set(handlerNode.id + '\0' + full, { line: lineBase, full });
      }
    }
  }

  // Phase 2c: SubStates virtual producers
  for (const mapping of subStatesMappings) {
    const { parentVariantFull, subStateName, defaultVariant } = mapping;
    const { full: normalizedParentFull, variant: parentVar } = normalizeStateName(parentVariantFull);
    const parentEntry = states.get(parentVar);
    if (!parentEntry) continue;
    for (const [producerKey, pInfo] of parentEntry.producers) {
      if (pInfo.full !== normalizedParentFull && pInfo.full !== parentVar) continue;
      const virtualFull = subStateName + '::' + defaultVariant;
      const subEntry = ensure(defaultVariant);
      const virtualKey = producerKey.split('\0')[0]! + '\0' + virtualFull;
      if (!subEntry.producers.has(virtualKey)) {
        subEntry.producers.set(virtualKey, { line: pInfo.line, full: virtualFull });
      }
    }
  }

  // Direct state edges
  for (const [stateKey, data] of states) {
    if (data.producers.size === 0 || data.consumers.size === 0) continue;
    for (const [producerKey, pInfo] of data.producers) {
      const producerId = producerKey.split('\0')[0]!;
      for (const [consumerKey, cInfo] of data.consumers) {
        const consumerId = consumerKey.split('\0')[0]!;
        if (producerId === consumerId) continue;
        if (pInfo.full !== stateKey && cInfo.full !== stateKey && pInfo.full !== cInfo.full) continue;
        const dedupKey = `${producerId}>${consumerId}>calls`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        edges.push({
          source: producerId,
          target: consumerId,
          kind: 'calls',
          line: pInfo.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-state', stateName: stateKey },
        });
      }
    }
  }

  // CR7: producer→state_variant reference edges
  for (const [stateKey, data] of states) {
    if (data.producers.size === 0) continue;
    for (const [producerKey, pInfo] of data.producers) {
      const producerId = producerKey.split('\0')[0]!;
      const variantNodes = ctx.getNodesByName(stateKey);
      for (const vn of variantNodes) {
        if (vn.kind !== 'enum_member') continue;
        const refDedupKey = `${producerId}>${vn.id}:ref`;
        if (seen.has(refDedupKey)) continue;
        seen.add(refDedupKey);
        edges.push({
          source: producerId,
          target: vn.id,
          kind: 'references',
          line: pInfo.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-state', stateName: stateKey },
        });
      }
    }
  }

  // ComputedStates intermediate-node edges
  const MAX_COMPUTED_PER_SOURCE = 200;
  const GLOBAL_COMPUTED_CAP = 600;
  let globalComputedCount = 0;

  for (const [sourceTypeName, computedNames] of computedFromSource) {
    if (globalComputedCount >= GLOBAL_COMPUTED_CAP) break;

    const sourceProducers = new Map<string, { line: number; full: string }>();
    for (const [, data] of states) {
      for (const [producerKey, pInfo] of data.producers) {
        if (pInfo.full === sourceTypeName || pInfo.full.startsWith(sourceTypeName + '::')) {
          sourceProducers.set(producerKey, pInfo);
        }
      }
    }
    if (sourceProducers.size === 0) continue;

    let perSourceCount = 0;
    for (const computedName of computedNames) {
      if (perSourceCount >= MAX_COMPUTED_PER_SOURCE || globalComputedCount >= GLOBAL_COMPUTED_CAP) break;

      const computedNodes = ctx.getNodesByName(computedName);
      const computedNode = computedNodes.find((n) => n.kind === 'struct' || n.kind === 'enum');
      if (!computedNode) continue;

      for (const [producerKey, pInfo] of sourceProducers) {
        if (perSourceCount >= MAX_COMPUTED_PER_SOURCE || globalComputedCount >= GLOBAL_COMPUTED_CAP) break;
        const producerId = producerKey.split('\0')[0]!;
        const dedupKey = `${producerId}>${computedNode.id}>calls`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        edges.push({
          source: producerId,
          target: computedNode.id,
          kind: 'calls',
          line: pInfo.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'bevy-ecs-state',
            computedState: computedName,
            transitiveVia: sourceTypeName,
          },
        });
        perSourceCount++;
        globalComputedCount++;
      }

      for (const [, data] of states) {
        if (data.consumers.size === 0) continue;
        for (const [consumerKey, cInfo] of data.consumers) {
          if (cInfo.full !== computedName && !cInfo.full.startsWith(computedName + '::')) continue;
          if (perSourceCount >= MAX_COMPUTED_PER_SOURCE || globalComputedCount >= GLOBAL_COMPUTED_CAP) break;
          const consumerId = consumerKey.split('\0')[0]!;
          const dedupKey = `${computedNode.id}>${consumerId}>calls`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          edges.push({
            source: computedNode.id,
            target: consumerId,
            kind: 'calls',
            line: cInfo.line,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'bevy-ecs-state',
              computedState: computedName,
            },
          });
          perSourceCount++;
          globalComputedCount++;
        }
        if (perSourceCount >= MAX_COMPUTED_PER_SOURCE || globalComputedCount >= GLOBAL_COMPUTED_CAP) break;
      }
    }
  }

  return edges;
}
