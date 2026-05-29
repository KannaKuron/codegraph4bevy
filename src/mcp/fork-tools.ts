/**
 * Fork MCP tool extensions.
 *
 * Standalone functions extracted from ToolHandler in tools.ts.
 * Each function receives a `ToolContext` (wrapping class helpers) so
 * upstream changes to tools.ts rarely touch this file.
 */

import type CodeGraph from '../index';
import type { Node, Edge, Subgraph, NodeKind, EdgeKind, UnresolvedReference } from '../types';
import type { ToolResult } from './tools';
import { classifyBevyEdgeRisk, isBevyPluginStruct, formatBevyWidgetOverview } from './bevy-formatters';
import { clamp } from '../utils';

/**
 * Minimum interface for class helper methods that extracted functions call.
 * Keeps the coupling surface explicit — only the helpers actually used
 * are listed here.
 */
export interface ToolContext {
  cg: CodeGraph;
  findAllSymbols(symbol: string): { nodes: Node[]; note: string };
  findSymbol(symbol: string): { node: Node; note: string } | null;
  matchesSymbol(node: Node, symbol: string): boolean;
  validateString(value: unknown, name: string): string | ToolResult;
  textResult(text: string): ToolResult;
  truncateOutput(text: string): string;
  sourceLineAt(ref: string | undefined, cache: Map<string, string[]>): string | null;
  sourceRangeAt(filePath: string, startLine: number, endLine: number, cache: Map<string, string[]>, maxLines?: number, maxChars?: number): string | null;
  classifyMutability(signature: string | undefined | null, typeName: string): 'mut' | 'shared' | 'owning' | 'unknown';
  formatUsageResults(symbol: string, usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }>, limit: number): string;
  formatNodeDetails(node: Node, code: string | null, outline?: string | null): string;
  formatTrail(node: Node): string;
  formatSchedule(node: Node): string;
  buildContainerOutline(node: Node): string;
}

// ── Pure utility functions (no ToolContext needed) ───────────────────────

/**
 * Classify an edge kind by risk level for impact analysis.
 */
export function classifyEdgeRisk(kind: EdgeKind): 'high' | 'medium' | 'low' {
  const bevy = classifyBevyEdgeRisk(kind);
  if (bevy) return bevy;
  switch (kind) {
    case 'calls':
    case 'extends':
    case 'implements':
    case 'overrides':
    case 'pattern_match':
      return 'high';
    case 'instantiates':
    case 'imports':
    case 'exports':
    case 'decorates':
      return 'medium';
    case 'references':
    case 'type_of':
    case 'returns':
      return 'low';
    default:
      console.warn(`[CodeGraph] classifyEdgeRisk: unhandled EdgeKind "${kind}", defaulting to 'low'`);
      return 'low';
  }
}

/**
 * Format the file symbols section for codegraph_files output.
 */
export function formatFileSymbols(
  symbolMap: Map<string, Array<{ name: string; kind: string }>>,
  totalFiles: number,
): string {
  const lines: string[] = ['### Top-Level Symbols', ''];

  const sorted = [...symbolMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [filePath, symbols] of sorted) {
    if (symbols.length === 0) continue;
    const symbolList = symbols.map(s => `${s.name} (${s.kind})`).join(', ');
    lines.push(`- **${filePath}:** ${symbolList}`);
  }

  const filesWithSymbols = sorted.filter(([, s]) => s.length > 0).length;
  if (filesWithSymbols < totalFiles) {
    lines.push('');
    lines.push(`*${totalFiles - filesWithSymbols} files have no top-level symbols*`);
  }

  return lines.join('\n');
}

/**
 * Bulk-fetch top-level symbols for a set of files.
 */
export function fetchTopLevelSymbols(
  cg: CodeGraph,
  files: Array<{ path: string; language: string; nodeCount: number }>,
): Map<string, Array<{ name: string; kind: string }>> {
  const symbolMap = new Map<string, Array<{ name: string; kind: string }>>();
  const fileSet = new Set(files.map(f => f.path));

  const results = cg.searchNodes('', {
    kinds: ['function', 'method', 'class', 'struct', 'enum', 'trait', 'interface', 'type_alias', 'module'] as NodeKind[],
    limit: Math.min(files.length * 10, 5000),
  });

  const perFileCap = files.length > 1000 ? 5 : 10;

  for (const r of results) {
    const fp = r.node.filePath;
    if (!fileSet.has(fp)) continue;

    let symbols = symbolMap.get(fp);
    if (!symbols) {
      symbols = [];
      symbolMap.set(fp, symbols);
    }
    if (symbols.length >= perFileCap) continue;

    const name = r.node.name.length > 30
      ? r.node.name.slice(0, 27) + '...'
      : r.node.name;
    symbols.push({ name, kind: r.node.kind });
  }

  return symbolMap;
}

// ── Functions that need ToolContext ──────────────────────────────────────

/**
 * Format impact analysis with BFS distance layers and risk classification.
 */
export function formatImpact(
  ctx: ToolContext,
  symbol: string,
  impact: Subgraph,
  codeSource: CodeGraph | null,
): string {
  const nodeCount = impact.nodes.size;

  // Compute BFS distance from root nodes to all affected nodes
  const rootSet = new Set(impact.roots);
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const rootId of impact.roots) {
    distance.set(rootId, 0);
    queue.push(rootId);
  }
  const adj = new Map<string, string[]>();
  for (const e of impact.edges) {
    if (e.kind === 'contains') continue;
    const targets = adj.get(e.target) || [];
    targets.push(e.source);
    adj.set(e.target, targets);
  }
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h]!;
    const curDist = distance.get(cur)!;
    const sources = adj.get(cur) || [];
    for (const src of sources) {
      if (!distance.has(src)) {
        distance.set(src, curDist + 1);
        queue.push(src);
      }
    }
  }

  // Group by risk level
  const ENVELOPE_KINDS = new Set(['class', 'struct', 'interface', 'enum', 'namespace', 'module', 'trait', 'protocol', 'component']);
  const levels: Array<{ label: string; desc: string; nodes: Map<string, Node[]> }> = [
    { label: 'Level 1 (direct)', desc: 'Directly references — must review if changing', nodes: new Map() },
    { label: 'Level 2 (indirect)', desc: 'One hop away — likely affected', nodes: new Map() },
    { label: 'Level 3 (transitive)', desc: 'Two or more hops — may be affected', nodes: new Map() },
  ];

  for (const node of impact.nodes.values()) {
    if (node.kind === 'file' || rootSet.has(node.id)) continue;
    const d = distance.get(node.id) ?? 99;
    const levelIdx = d <= 1 ? 0 : d <= 2 ? 1 : 2;
    const byFile = levels[levelIdx]!.nodes;
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  // Build nodeId → incoming edge kinds mapping for risk classification
  const nodeIncomingKinds = new Map<string, EdgeKind[]>();
  for (const e of impact.edges) {
    if (e.kind === 'contains') continue;
    const kinds = nodeIncomingKinds.get(e.target) || [];
    kinds.push(e.kind);
    nodeIncomingKinds.set(e.target, kinds);
  }

  // Overall risk breakdown
  let totalHigh = 0, totalMedium = 0, totalLow = 0;
  for (const [nodeId, kinds] of nodeIncomingKinds.entries()) {
    if (kinds.length === 0) continue;
    if (nodeId.startsWith('file:') || rootSet.has(nodeId)) continue;
    let hasHigh = false, hasMedium = false;
    for (const k of kinds) {
      const risk = classifyEdgeRisk(k);
      if (risk === 'high') hasHigh = true;
      else if (risk === 'medium') hasMedium = true;
    }
    if (hasHigh) totalHigh++;
    else if (hasMedium) totalMedium++;
    else totalLow++;
  }

  const lines: string[] = [
    `## Impact: "${symbol}" affects ${nodeCount} symbols`,
    '',
  ];
  if (totalHigh > 0 || totalMedium > 0 || totalLow > 0) {
    const parts: string[] = [];
    if (totalHigh > 0) parts.push(`${totalHigh} high-risk`);
    if (totalMedium > 0) parts.push(`${totalMedium} medium-risk`);
    if (totalLow > 0) parts.push(`${totalLow} low-risk`);
    lines.push(`**Risk breakdown:** ${parts.join(', ')}`, '');
  }

  for (const level of levels) {
    const files: Array<{ filePath: string; nodes: Node[] }> = [];
    for (const [filePath, fileNodes] of level.nodes) {
      const specific = fileNodes.filter(n => !ENVELOPE_KINDS.has(n.kind));
      if (specific.length > 0) {
        files.push({ filePath, nodes: specific });
      } else {
        files.push({ filePath, nodes: fileNodes });
      }
    }
    if (files.length === 0) continue;

    let levelNodeCount = 0;
    for (const f of files) levelNodeCount += f.nodes.length;

    const levelNodeIds = new Set(files.flatMap(f => f.nodes.map(n => n.id)));
    let lvlHigh = 0, lvlMedium = 0, lvlLow = 0;
    const lvlByKind = new Map<string, number>();
    for (const nid of levelNodeIds) {
      const kinds = nodeIncomingKinds.get(nid) || [];
      if (kinds.length === 0) continue;
      let hasHigh = false, hasMedium = false;
      const seenKinds = new Set<string>();
      for (const k of kinds) {
        if (seenKinds.has(k)) continue;
        seenKinds.add(k);
        const risk = classifyEdgeRisk(k);
        if (risk === 'high') hasHigh = true;
        else if (risk === 'medium') hasMedium = true;
        lvlByKind.set(k, (lvlByKind.get(k) || 0) + 1);
      }
      if (hasHigh) lvlHigh++;
      else if (hasMedium) lvlMedium++;
      else lvlLow++;
    }
    const riskParts: string[] = [];
    if (lvlHigh > 0) {
      const highKinds = [...lvlByKind.entries()]
        .filter(([k]) => classifyEdgeRisk(k as EdgeKind) === 'high')
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${c} ${k}`).join(', ');
      riskParts.push(`${lvlHigh} high-risk (${highKinds})`);
    }
    if (lvlMedium > 0) {
      const medKinds = [...lvlByKind.entries()]
        .filter(([k]) => classifyEdgeRisk(k as EdgeKind) === 'medium')
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${c} ${k}`).join(', ');
      riskParts.push(`${lvlMedium} medium-risk (${medKinds})`);
    }
    if (lvlLow > 0) riskParts.push(`${lvlLow} low-risk`);
    const riskSuffix = riskParts.length > 0 ? ` [${riskParts.join('; ')}]` : '';

    lines.push(`### ${level.label} — ${level.desc} (${levelNodeCount} symbols)${riskSuffix}`);
    lines.push('');
    const isLevel1 = level.label.startsWith('Level 1');
    const fileCache = new Map<string, string[]>();
    for (const { filePath, nodes } of files) {
      const nodeList = nodes.slice(0, 10).map(n => `${n.name}:${n.startLine}`).join(', ');
      const tail = nodes.length > 10 ? `, +${nodes.length - 10} more` : '';
      lines.push(`- **${filePath}:** ${nodeList}${tail}`);
      if (isLevel1 && codeSource) {
        for (const n of nodes.slice(0, 10)) {
          const src = ctx.sourceRangeAt(n.filePath, n.startLine, n.endLine, fileCache, 8, 400);
          if (src) {
            lines.push(`  \`${n.name}\`: ${src.split('\n').map(l => '  ' + l.trim()).join('\n')}`);
          }
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format usages grouped by edge kind for kind="all" output.
 */
export function formatAllKindUsages(
  ctx: ToolContext,
  usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }>,
  symbol: string, limit: number, note: string,
): ToolResult {
  const byKind = new Map<string, typeof usages>();
  for (const u of usages) {
    const arr = byKind.get(u.edgeKind) || [];
    arr.push(u);
    byKind.set(u.edgeKind, arr);
  }

  const lines: string[] = [
    `## All usages of "${symbol}" (${usages.length} total across ${byKind.size} edge kinds)`,
    '',
  ];

  for (const [kind, kindUsages] of byKind) {
    lines.push(`### ${kind} (${kindUsages.length})`);
    for (const u of kindUsages.slice(0, limit)) {
      const lineInfo = u.line ? `:${u.line}` : '';
      lines.push(`- ${u.sourceNode.name} (${u.sourceNode.kind}) → ${u.targetNode.name}${lineInfo}`);
    }
    if (kindUsages.length > limit) {
      lines.push(`  ... and ${kindUsages.length - limit} more`);
    }
    lines.push('');
  }

  lines.push(note);
  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Format external callers from unresolved references (include_external=true, no project symbol).
 */
export function formatExternalCallers(
  ctx: ToolContext,
  unresolved: UnresolvedReference[],
  symbol: string,
  limit: number,
): ToolResult {
  const seen = new Set<string>();
  const callers: Array<{ name: string; line: number; kind: string; filePath: string }> = [];
  for (const ref of unresolved) {
    if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'references'
        && ref.referenceKind !== 'macro_call' && ref.referenceKind !== 'pattern_match') continue;
    const key = `${ref.fromNodeId}:${ref.referenceKind}:${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    callers.push({
      name: ref.referenceName,
      line: ref.line,
      kind: ref.referenceKind === 'macro_call' ? 'external macro' : 'external',
      filePath: ref.filePath ?? '',
    });
  }

  if (callers.length === 0) {
    return ctx.textResult(`No external callers found for "${symbol}"`);
  }

  const byFile = new Map<string, typeof callers>();
  for (const c of callers) {
    const arr = byFile.get(c.filePath) || [];
    arr.push(c);
    byFile.set(c.filePath, arr);
  }

  const shown = callers.slice(0, limit);
  const lines: string[] = [
    `## External Callers of "${symbol}" (${shown.length} shown, ${callers.length} total)`,
    '',
    '> External symbol — no project-internal node found. Results from unresolved references.',
    '',
  ];
  for (const [file, fileCallers] of byFile) {
    lines.push(`**${file}:**`);
    for (const c of fileCallers) {
      lines.push(`- ${c.name} (${c.kind}) line ${c.line}`);
    }
    lines.push('');
  }
  if (callers.length > limit) {
    lines.push(`... and ${callers.length - limit} more callers`);
  }
  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Resolve usages from unresolved references for external symbols.
 * Returns null when no matching unresolved refs exist.
 */
export function handleUsagesFromUnresolved(
  ctx: ToolContext,
  symbol: string,
  limit: number,
  kindFilter?: string,
): ToolResult | null {
  const unresolved = ctx.cg.getUnresolvedByName(symbol);
  if (unresolved.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const usages: Array<{ sourceNode: Node; edgeKind: string; line: number }> = [];
  for (const ref of unresolved) {
    if (kindFilter && ref.referenceKind !== kindFilter) continue;
    const key = `${ref.fromNodeId}:${ref.referenceKind}:${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sourceNode = ctx.cg.getNode(ref.fromNodeId);
    if (sourceNode) {
      usages.push({ sourceNode, edgeKind: ref.referenceKind, line: ref.line });
    }
  }

  if (usages.length === 0) {
    return null;
  }

  const byFile = new Map<string, typeof usages>();
  for (const u of usages) {
    const existing = byFile.get(u.sourceNode.filePath) || [];
    existing.push(u);
    byFile.set(u.sourceNode.filePath, existing);
  }

  const lines: string[] = [
    `## Usages of "${symbol}" (${Math.min(usages.length, limit)} shown, ${usages.length} total)`,
    '',
    '> External symbol — no project-internal node found. Results from unresolved references.',
    '',
  ];

  let count = 0;
  for (const [file, fileUsages] of byFile) {
    if (count >= limit) break;
    lines.push(`**${file}:**`);
    for (const u of fileUsages) {
      if (count >= limit) break;
      const lineInfo = u.line ? `:${u.line}` : '';
      lines.push(`- ${u.sourceNode.name} (${u.sourceNode.kind}) ${u.edgeKind}→ ${symbol}${lineInfo}`);
      count++;
    }
    lines.push('');
  }

  if (usages.length > limit) {
    lines.push(`... and ${usages.length - limit} more usages`);
  }

  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Handle callers with a kind filter — general usages mode.
 * Checks both incoming and outgoing edges for the specified kind.
 */
export function handleCallersWithKind(
  ctx: ToolContext,
  symbol: string,
  limit: number,
  kindFilter: string,
  mutability?: string,
): ToolResult {
  const effectiveKind = kindFilter.startsWith('bevy:') ? kindFilter.slice(5) : kindFilter;
  const allMatches = ctx.findAllSymbols(symbol);
  if (allMatches.nodes.length === 0) {
    return ctx.textResult(`Symbol "${symbol}" not found in the codebase`);
  }
  const exactMatch = allMatches.nodes.some(n => ctx.matchesSymbol(n, symbol));
  if (!exactMatch) {
    const unresolvedResult = handleUsagesFromUnresolved(ctx, symbol, limit, effectiveKind);
    if (unresolvedResult !== null) return unresolvedResult;
  }

  const ALWAYS_EXPAND = new Set(['enum', 'trait', 'interface']);
  const STRUCT_LIKE = new Set(['struct', 'class']);
  const nodesToQuery: Node[] = [...allMatches.nodes];
  for (const node of allMatches.nodes) {
    if (ALWAYS_EXPAND.has(node.kind) ||
        (STRUCT_LIKE.has(node.kind) && effectiveKind !== 'type_of')) {
      for (const child of ctx.cg.getChildren(node.id)) {
        if (!nodesToQuery.some(n => n.id === child.id)) {
          nodesToQuery.push(child);
        }
      }
    }
  }

  const seen = new Set<string>();
  const usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }> = [];
  const edgeKinds: EdgeKind[] | undefined = effectiveKind === 'all' ? undefined : [effectiveKind as EdgeKind];

  for (const node of nodesToQuery) {
    for (const edge of ctx.cg.getIncomingEdges(node.id, edgeKinds)) {
      const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceNode = ctx.cg.getNode(edge.source);
      if (sourceNode) {
        usages.push({ sourceNode, targetNode: node, edgeKind: edge.kind, line: edge.line ?? sourceNode.startLine });
      }
    }
    if (effectiveKind !== 'calls') {
      for (const edge of ctx.cg.getOutgoingEdges(node.id)) {
        if (edgeKinds !== undefined && !edgeKinds.includes(edge.kind)) continue;
        const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const targetNode = ctx.cg.getNode(edge.target);
        if (targetNode) {
          usages.push({ sourceNode: node, targetNode, edgeKind: edge.kind, line: edge.line ?? node.startLine });
        }
      }
    }
  }

  if (usages.length === 0) {
    return ctx.textResult(`No usages of kind "${kindFilter}" found for "${symbol}"${allMatches.note}`);
  }

  if (mutability && (mutability === 'mut' || mutability === 'shared' || mutability === 'owning')) {
    const filtered: typeof usages = [];
    for (const u of usages) {
      if (ctx.classifyMutability(u.sourceNode.signature, symbol) === mutability) {
        filtered.push(u);
      }
    }
    usages.length = 0;
    usages.push(...filtered.slice(0, limit));
  }

  if (usages.length === 0) {
    return ctx.textResult(`No usages of kind "${kindFilter}" with mutability="${mutability}" found for "${symbol}"${allMatches.note}`);
  }

  if (effectiveKind === 'all') {
    return formatAllKindUsages(ctx, usages, symbol, limit, allMatches.note);
  }

  const byFile = new Map<string, typeof usages>();
  for (const u of usages) {
    const existing = byFile.get(u.sourceNode.filePath) || [];
    existing.push(u);
    byFile.set(u.sourceNode.filePath, existing);
  }

  const lines: string[] = [
    `## ${kindFilter} usages of "${symbol}" (${Math.min(usages.length, limit)} shown, ${usages.length} total)`,
    '',
  ];

  let count = 0;
  for (const [file, fileUsages] of byFile) {
    if (count >= limit) break;
    lines.push(`**${file}:**`);
    for (const u of fileUsages) {
      if (count >= limit) break;
      const lineInfo = u.line ? `:${u.line}` : '';
      lines.push(`- ${u.sourceNode.name} (${u.sourceNode.kind}) ${u.edgeKind}→ ${u.targetNode.name}${lineInfo}`);
      count++;
    }
    lines.push('');
  }

  if (usages.length > limit) {
    lines.push(`... and ${usages.length - limit} more usages`);
  }
  lines.push(allMatches.note);
  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Batch mode for kind-filtered callers (general usages).
 */
export function handleBatchUsagesMode(
  ctx: ToolContext,
  symbols: string[],
  limit: number,
  kindFilter: string,
  mutability?: string,
): ToolResult {
  const effectiveKind = kindFilter.startsWith('bevy:') ? kindFilter.slice(5) : kindFilter;
  const batchLimit = Math.min(symbols.length, 20);
  const lines: string[] = [`## Batch ${kindFilter} Usages (${batchLimit} symbols)`, ''];
  let totalUsages = 0;

  for (const symbol of symbols.slice(0, batchLimit)) {
    const valid = ctx.validateString(symbol, 'symbols');
    if (typeof valid !== 'string') {
      lines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
      lines.push('');
      continue;
    }
    const allMatches = ctx.findAllSymbols(valid);
    if (allMatches.nodes.length === 0) {
      const unresolvedResult = handleUsagesFromUnresolved(ctx, valid, Math.max(3, Math.ceil(limit / batchLimit)), effectiveKind);
      if (unresolvedResult !== null) {
        lines.push((unresolvedResult.content[0] as { type: 'text'; text: string }).text);
        lines.push('');
      } else {
        lines.push(`### ${valid}: not found`); lines.push('');
      }
      continue;
    }
    const exactMatch = allMatches.nodes.some(n => ctx.matchesSymbol(n, valid));
    if (!exactMatch) {
      const unresolvedResult = handleUsagesFromUnresolved(ctx, valid, Math.max(3, Math.ceil(limit / batchLimit)), effectiveKind);
      if (unresolvedResult !== null) {
        lines.push((unresolvedResult.content[0] as { type: 'text'; text: string }).text);
        lines.push('');
        continue;
      }
    }
    const CONTAINER_KINDS_BATCH = new Set(['enum', 'struct', 'trait', 'class', 'interface']);
    const nodesToQuery: Node[] = [...allMatches.nodes];
    for (const node of allMatches.nodes) {
      if (CONTAINER_KINDS_BATCH.has(node.kind)) {
        for (const child of ctx.cg.getChildren(node.id)) {
          if (!nodesToQuery.some(n => n.id === child.id)) {
            nodesToQuery.push(child);
          }
        }
      }
    }

    const seen = new Set<string>();
    const usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }> = [];
    const edgeKinds: EdgeKind[] | undefined = effectiveKind === 'all' ? undefined : [effectiveKind as EdgeKind];
    for (const node of nodesToQuery) {
      for (const edge of ctx.cg.getIncomingEdges(node.id, edgeKinds)) {
        const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceNode = ctx.cg.getNode(edge.source);
        if (sourceNode) { usages.push({ sourceNode, targetNode: node, edgeKind: edge.kind, line: edge.line ?? sourceNode.startLine }); }
      }
      if (effectiveKind !== 'calls') {
        for (const edge of ctx.cg.getOutgoingEdges(node.id)) {
          if (edgeKinds !== undefined && !edgeKinds.includes(edge.kind)) continue;
          const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const targetNode = ctx.cg.getNode(edge.target);
          if (targetNode) { usages.push({ sourceNode: node, targetNode, edgeKind: edge.kind, line: edge.line ?? node.startLine }); }
        }
      }
    }

    if (mutability && (mutability === 'mut' || mutability === 'shared' || mutability === 'owning')) {
      const filtered: typeof usages = [];
      for (const u of usages) {
        if (ctx.classifyMutability(u.sourceNode.signature, valid) === mutability) {
          filtered.push(u);
        }
      }
      usages.length = 0;
      usages.push(...filtered);
    }

    const perLimit = Math.max(3, Math.ceil(limit / batchLimit));
    lines.push(ctx.formatUsageResults(valid, usages, perLimit));
    lines.push('');
    if (allMatches.note) lines.push(allMatches.note);
    totalUsages += usages.length;
  }
  lines.push('---');
  lines.push(`Total: ${totalUsages} usages across ${batchLimit} symbols`);
  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Handle batch codegraph_callers — multiple symbols in one call.
 */
export function handleBatchCallers(
  ctx: ToolContext,
  symbols: string[],
  limit: number,
): ToolResult {
  const batchLimit = Math.min(symbols.length, 20);
  const allLines: string[] = [`## Batch Callers (${batchLimit} symbols)`, ''];
  const fileCache = new Map<string, string[]>();
  let totalCallers = 0;

  for (const symbol of symbols.slice(0, batchLimit)) {
    const valid = ctx.validateString(symbol, 'symbols');
    if (typeof valid !== 'string') {
      allLines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
      allLines.push('');
      continue;
    }
    const allMatches = ctx.findAllSymbols(valid);
    if (allMatches.nodes.length === 0) {
      allLines.push(`### ${valid}: not found`);
      allLines.push('');
      continue;
    }

    const callSites: Array<{ caller: Node; edge: Edge }> = [];
    const seen = new Set<string>();
    for (const node of allMatches.nodes) {
      for (const c of ctx.cg.getCallers(node.id)) {
        const key = `${c.node.id}:${c.edge.line ?? c.node.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          callSites.push({ caller: c.node, edge: c.edge });
        }
      }
    }

    const perLimit = Math.max(3, Math.ceil(limit / batchLimit));
    const shown = callSites.slice(0, perLimit);
    allLines.push(`### ${valid} (${shown.length} shown, ${callSites.length} total)`);
    allLines.push('');
    for (const cs of shown) {
      const defLine = cs.caller.startLine ? `:${cs.caller.startLine}` : '';
      const callLine = cs.edge.line ?? cs.caller.startLine;
      const fileRef = `${cs.caller.filePath}:${callLine}`;
      const snippet = ctx.sourceLineAt(fileRef, fileCache);
      allLines.push(`- **${cs.caller.name}** (${cs.caller.kind})`);
      allLines.push(`  def: ${cs.caller.filePath}${defLine}`);
      allLines.push(`  call: ${cs.caller.filePath}:${callLine}${snippet ? ` — \`${snippet}\`` : ''}`);
      allLines.push('');
    }
    if (callSites.length > perLimit) {
      allLines.push(`... and ${callSites.length - perLimit} more callers`);
      allLines.push('');
    }
    if (allMatches.note) allLines.push(allMatches.note);
    totalCallers += callSites.length;
  }

  allLines.push('---');
  allLines.push(`Total: ${totalCallers} callers across ${batchLimit} symbols`);
  return ctx.textResult(ctx.truncateOutput(allLines.join('\n')));
}

/**
 * Handle batch codegraph_impact — multiple symbols in one call.
 */
export function handleBatchImpact(
  ctx: ToolContext,
  symbols: string[],
  args: Record<string, unknown>,
): ToolResult {
  const batchLimit = Math.min(symbols.length, 20);
  const depth = clamp((args.depth as number) || 2, 1, 10);
  const includeCode = args.includeCode === true;
  const allLines: string[] = [`## Batch Impact (${batchLimit} symbols)`, ''];
  let totalAffected = 0;

  for (const symbol of symbols.slice(0, batchLimit)) {
    const valid = ctx.validateString(symbol, 'symbols');
    if (typeof valid !== 'string') {
      allLines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
      allLines.push('');
      continue;
    }
    const allMatches = ctx.findAllSymbols(valid);
    if (allMatches.nodes.length === 0) {
      allLines.push(`### ${valid}: not found`);
      allLines.push('');
      continue;
    }

    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();

    for (const node of allMatches.nodes) {
      const impact = ctx.cg.getImpactRadius(node.id, depth);
      for (const [id, n] of impact.nodes) {
        mergedNodes.set(id, n);
      }
      for (const e of impact.edges) {
        const key = `${e.source}->${e.target}:${e.kind}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          mergedEdges.push(e);
        }
      }
    }

    const mergedImpact = {
      nodes: mergedNodes,
      edges: mergedEdges,
      roots: allMatches.nodes.map(n => n.id),
    };

    const affectedCount = mergedNodes.size - allMatches.nodes.length;
    allLines.push(formatImpact(ctx, valid, mergedImpact, includeCode ? ctx.cg : null));
    if (allMatches.note) allLines.push(allMatches.note);
    allLines.push('');
    totalAffected += affectedCount;
  }

  allLines.push('---');
  allLines.push(`Total: ${totalAffected} affected nodes across ${batchLimit} symbols`);
  return ctx.textResult(ctx.truncateOutput(allLines.join('\n')));
}

/**
 * Handle codegraph_symbol_info — aggregated symbol information.
 */
export async function handleSymbolInfo(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const symbol = ctx.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const allMatches = ctx.findAllSymbols(symbol);
  if (allMatches.nodes.length === 0) {
    return ctx.textResult(`Symbol "${symbol}" not found`);
  }

  const lines: string[] = [`## Symbol Info: "${symbol}"`, ''];

  for (const node of allMatches.nodes) {
    // Issue #9: Bevy Plugin struct → structured widget overview
    if (isBevyPluginStruct(ctx.cg, node)) {
      const widgetOverview = formatBevyWidgetOverview(ctx.cg, node);
      if (widgetOverview) {
        lines.push(widgetOverview);
        lines.push('');
        const incoming = ctx.cg.getIncomingEdges(node.id);
        const inByKind = new Map<string, Edge[]>();
        for (const e of incoming) {
          const arr = inByKind.get(e.kind) || [];
          arr.push(e);
          inByKind.set(e.kind, arr);
        }
        if (inByKind.size > 0) {
          lines.push('#### 引用者 (Incoming Edges)');
          for (const [kind, edges] of inByKind) {
            lines.push(`- ${kind}: ${edges.length}`);
          }
          lines.push('');
        }
        const impact = ctx.cg.getImpactRadius(node.id, 2);
        const rootSet = new Set(impact.roots);
        let l1 = 0, l2 = 0, l3 = 0;
        const dist = new Map<string, number>();
        const queue: string[] = [];
        for (const rootId of impact.roots) {
          dist.set(rootId, 0);
          queue.push(rootId);
        }
        const adj = new Map<string, string[]>();
        for (const e of impact.edges) {
          if (e.kind === 'contains') continue;
          const targets = adj.get(e.target) || [];
          targets.push(e.source);
          adj.set(e.target, targets);
        }
        for (let h = 0; h < queue.length; h++) {
          const cur = queue[h]!;
          const curDist = dist.get(cur)!;
          const sources = adj.get(cur) || [];
          for (const src of sources) {
            if (!dist.has(src)) {
              dist.set(src, curDist + 1);
              queue.push(src);
            }
          }
        }
        for (const n of impact.nodes.values()) {
          if (n.kind === 'file' || rootSet.has(n.id)) continue;
          const d = dist.get(n.id) ?? 99;
          if (d <= 1) l1++;
          else if (d <= 2) l2++;
          else l3++;
        }
        lines.push(`- **影响半径**: ${impact.nodes.size} nodes, L1=${l1}, L2=${l2}, L3=${l3}`);
        lines.push('');
        continue;
      }
    }

    lines.push(`### ${node.name} (${node.kind})`);
    lines.push(`- **定义**: ${node.filePath}:${node.startLine}`);
    if (node.signature) lines.push(`- **签名**: \`${node.signature}\``);

    const incoming = ctx.cg.getIncomingEdges(node.id);
    const inByKind = new Map<string, Edge[]>();
    for (const e of incoming) {
      const arr = inByKind.get(e.kind) || [];
      arr.push(e);
      inByKind.set(e.kind, arr);
    }
    lines.push(`- **引用者** (${inByKind.size} kinds):`);
    for (const [kind, edges] of inByKind) {
      lines.push(`  - ${kind}: ${edges.length}`);
    }

    const callees = ctx.cg.getCallees(node.id);
    if (callees.length > 0) {
      lines.push(`- **被调用者** (${callees.length}):`);
      for (const c of callees.slice(0, 5)) {
        lines.push(`  - ${c.node.name} (${c.node.filePath}:${c.edge.line ?? c.node.startLine})`);
      }
      if (callees.length > 5) {
        lines.push(`  ... and ${callees.length - 5} more`);
      }
    }

    const impact = ctx.cg.getImpactRadius(node.id, 2);
    const rootSet = new Set(impact.roots);
    let l1 = 0, l2 = 0, l3 = 0;
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const rootId of impact.roots) {
      dist.set(rootId, 0);
      queue.push(rootId);
    }
    const adj = new Map<string, string[]>();
    for (const e of impact.edges) {
      if (e.kind === 'contains') continue;
      const targets = adj.get(e.target) || [];
      targets.push(e.source);
      adj.set(e.target, targets);
    }
    for (let h = 0; h < queue.length; h++) {
      const cur = queue[h]!;
      const curDist = dist.get(cur)!;
      const sources = adj.get(cur) || [];
      for (const src of sources) {
        if (!dist.has(src)) {
          dist.set(src, curDist + 1);
          queue.push(src);
        }
      }
    }
    for (const node of impact.nodes.values()) {
      if (node.kind === 'file' || rootSet.has(node.id)) continue;
      const d = dist.get(node.id) ?? 99;
      if (d <= 1) l1++;
      else if (d <= 2) l2++;
      else l3++;
    }
    lines.push(`- **影响半径**: ${impact.nodes.size} nodes, L1=${l1}, L2=${l2}, L3=${l3}`);
    lines.push('');
  }

  lines.push(allMatches.note);
  return ctx.textResult(ctx.truncateOutput(lines.join('\n')));
}

/**
 * Handle batch codegraph_node — multiple symbols in one call.
 */
export async function handleBatchNode(
  ctx: ToolContext,
  symbols: string[],
  includeCode: boolean,
  MAX_OUTPUT_LENGTH: number,
): Promise<ToolResult> {
  const batchLimit = Math.min(symbols.length, 20);
  const header = `## Batch Node Details (${batchLimit} symbols)`;
  const allLines: string[] = [header, ''];
  let totalLen = header.length + 2;
  const BUDGET = MAX_OUTPUT_LENGTH - 500;
  const skippedNames: string[] = [];

  for (const symbol of symbols.slice(0, batchLimit)) {
    if (totalLen > BUDGET) {
      skippedNames.push(typeof symbol === 'string' ? symbol : String(symbol));
      continue;
    }

    const valid = ctx.validateString(symbol, 'symbols');
    if (typeof valid !== 'string') {
      const msg = `### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`;
      allLines.push(msg, '');
      totalLen += msg.length + 2;
      continue;
    }
    const match = ctx.findSymbol(valid);
    if (!match) {
      const msg = `### ${valid}: not found`;
      allLines.push(msg, '');
      totalLen += msg.length + 2;
      continue;
    }

    const CONTAINER_NODE_KINDS = new Set<NodeKind>([
      'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
    ]);

    let code: string | null = null;
    let outline: string | null = null;
    if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
      outline = ctx.buildContainerOutline(match.node);
    }
    if (includeCode) {
      code = await ctx.cg.getCode(match.node.id);
    }

    const trail = ctx.formatTrail(match.node);
    const schedule = ctx.formatSchedule(match.node);
    const formatted = ctx.formatNodeDetails(match.node, code, outline) + schedule + trail + match.note;

    if (totalLen + formatted.length > BUDGET && allLines.length > 2) {
      skippedNames.push(valid);
      continue;
    }

    allLines.push(formatted, '');
    totalLen += formatted.length + 2;
  }

  if (skippedNames.length > 0) {
    const nameList = skippedNames.map(n => `"${n}"`).join(', ');
    allLines.push(`---`);
    allLines.push(`**${skippedNames.length} symbols not shown** (output budget reached). To get their source, use:`);
    allLines.push(`  codegraph_node(symbols: [${nameList}], includeCode)`);
  }

  allLines.push('---');
  allLines.push(`Total: ${batchLimit} symbols${skippedNames.length > 0 ? ` (${batchLimit - skippedNames.length} shown, ${skippedNames.length} deferred)` : ''}`);
  return ctx.textResult(ctx.truncateOutput(allLines.join('\n')));
}
