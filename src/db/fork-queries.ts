/**
 * Fork extension queries.
 *
 * Standalone functions that accept a `SqliteDatabase` directly, decoupled
 * from the QueryBuilder class.  The QueryBuilder delegates to these
 * functions so that upstream changes to queries.ts rarely touch this file.
 */

import { SqliteDatabase } from './sqlite-adapter';
import {
  UnresolvedReference,
  EdgeKind,
  Language,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';
import { escapeLike } from '../search/query-utils';
import { rowToNode, NodeRow, UnresolvedRefRow } from './queries';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Count incoming edges for a node (much faster than fetching all rows).
 */
export function getIncomingEdgeCount(db: SqliteDatabase, targetId: string, kinds?: EdgeKind[]): number {
  if (kinds && kinds.length > 0) {
    const sql = `SELECT COUNT(*) as cnt FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
    const row = db.prepare(sql).get(targetId, ...kinds) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM edges WHERE target = ?'
  ).get(targetId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Get unresolved references by source node ID.
 */
export function getUnresolvedByNode(db: SqliteDatabase, nodeId: string): UnresolvedReference[] {
  const rows = db.prepare(
    'SELECT * FROM unresolved_refs WHERE from_node_id = ?'
  ).all(nodeId) as UnresolvedRefRow[];
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
  }));
}

/**
 * Find nodes that reference a given type name (via type_of, references, returns edges).
 */
export function findNodesByReferencedType(
  db: SqliteDatabase,
  typeName: string,
  options: SearchOptions & { edgeKinds?: EdgeKind[] } = {},
): SearchResult[] {
  const { kinds, languages, limit = 50, edgeKinds } = options;
  const targetKinds = edgeKinds ?? ['type_of', 'references', 'returns'];

  let filterSql = '';
  const filterParams: (string | number)[] = [];
  if (kinds && kinds.length > 0) {
    filterSql += ` AND n.kind IN (${kinds.map(() => '?').join(',')})`;
    filterParams.push(...kinds);
  }
  if (languages && languages.length > 0) {
    filterSql += ` AND n.language IN (${languages.map(() => '?').join(',')})`;
    filterParams.push(...languages);
  }

  const kindPlaceholders = targetKinds.map(() => '?').join(',');
  const sql = `
    SELECT DISTINCT n.*, 1.0 as score
    FROM nodes n
    JOIN edges e ON n.id = e.source
    JOIN nodes t ON e.target = t.id
    WHERE t.name = ? COLLATE NOCASE
    AND e.kind IN (${kindPlaceholders})
    ${filterSql}
    UNION
    SELECT DISTINCT n.*, 0.8 as score
    FROM nodes n
    JOIN unresolved_refs u ON n.id = u.from_node_id
    WHERE u.reference_name = ? COLLATE NOCASE
    AND u.reference_kind IN (${kindPlaceholders})
    ${filterSql}
    ORDER BY score DESC, n.name ASC LIMIT ?
  `;

  const params: (string | number)[] = [
    typeName, ...targetKinds, ...filterParams,
    typeName, ...targetKinds, ...filterParams,
    limit,
  ];

  const rows = db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
  const seen = new Set<string>();
  const deduped: (NodeRow & { score: number })[] = [];
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      deduped.push(row);
    }
  }
  return deduped.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}

/**
 * Find nodes that implement a given trait/interface.
 */
export function findImplementors(
  db: SqliteDatabase,
  traitName: string,
  options: SearchOptions = {},
): SearchResult[] {
  const { kinds, languages, limit = 50 } = options;

  let filterSql = '';
  const filterParams: (string | number)[] = [];
  if (kinds && kinds.length > 0) {
    filterSql += ` AND n.kind IN (${kinds.map(() => '?').join(',')})`;
    filterParams.push(...kinds);
  }
  if (languages && languages.length > 0) {
    filterSql += ` AND n.language IN (${languages.map(() => '?').join(',')})`;
    filterParams.push(...languages);
  }

  const escapedTrait = escapeLike(traitName);

  const sql = `
    SELECT DISTINCT n.*, 1.0 as score FROM nodes n
    JOIN edges e ON n.id = e.source
    JOIN nodes t ON e.target = t.id
    WHERE t.name = ? COLLATE NOCASE AND e.kind = 'implements' ${filterSql}
    UNION
    SELECT DISTINCT n.*, 0.8 as score FROM nodes n
    JOIN unresolved_refs u ON n.id = u.from_node_id
    WHERE u.reference_name = ? COLLATE NOCASE AND u.reference_kind = 'implements' ${filterSql}
    UNION
    SELECT DISTINCT n.*, 0.6 as score FROM nodes n
    WHERE n.signature LIKE '%implements ' || ? || '%' ESCAPE '\\' COLLATE NOCASE
      AND n.kind IN ('struct', 'enum', 'class') ${filterSql}
    ORDER BY score DESC, n.name ASC LIMIT ?
  `;

  const params: (string | number)[] = [
    traitName, ...filterParams,
    traitName, ...filterParams,
    escapedTrait, ...filterParams,
    limit,
  ];

  const rows = db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
  const seen = new Set<string>();
  const deduped: (NodeRow & { score: number })[] = [];
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      deduped.push(row);
    }
  }
  return deduped.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}

/**
 * Search comments by text using FTS5.
 */
export function searchComments(
  db: SqliteDatabase,
  query: string,
  limit: number = 500,
): Array<{
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: string;
  associatedSymbol: string | null;
}> {
  const ftsQuery = query
    .replace(/::/g, ' ')
    .replace(/['"*():^\\]/g, '')
    .split(/\s+/)
    .filter(term => term.length > 0)
    .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
    .map(term => `"${term}"*`)
    .join(' OR ');

  if (!ftsQuery) return [];

  const sql = `
    SELECT c.file_path, c.start_line, c.end_line, c.text, c.kind, c.associated_symbol
    FROM comments_fts f
    JOIN comments c ON c.rowid = f.rowid
    WHERE comments_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(ftsQuery, limit) as Array<{
    file_path: string;
    start_line: number;
    end_line: number;
    text: string;
    kind: string;
    associated_symbol: string | null;
  }>;
  return rows.map(r => ({
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    text: r.text,
    kind: r.kind,
    associatedSymbol: r.associated_symbol,
  }));
}

// ── External Symbol Operations ──────────────────────────────────────────

/**
 * Get all external symbols for a type.
 */
export function getExternalSymbolsForType(
  db: SqliteDatabase,
  typeName: string,
): Array<{
  crateName: string;
  crateVersion: string;
  symbolName: string;
  symbolKind: string;
  methodName: string | null;
  paramTypes: string | null;
  returnType: string | null;
}> {
  const rows = db.prepare(
    `SELECT crate_name, crate_version, symbol_name, symbol_kind, method_name, param_types, return_type
     FROM external_symbols WHERE symbol_name = ?`
  ).all(typeName) as Array<{
    crate_name: string;
    crate_version: string;
    symbol_name: string;
    symbol_kind: string;
    method_name: string | null;
    param_types: string | null;
    return_type: string | null;
  }>;
  return rows.map(r => ({
    crateName: r.crate_name,
    crateVersion: r.crate_version,
    symbolName: r.symbol_name,
    symbolKind: r.symbol_kind,
    methodName: r.method_name,
    paramTypes: r.param_types,
    returnType: r.return_type,
  }));
}

/**
 * Insert or update an external symbol entry.
 */
export function upsertExternalSymbol(
  db: SqliteDatabase,
  params: {
    crateName: string;
    crateVersion: string;
    symbolName: string;
    symbolKind: string;
    methodName?: string;
    paramTypes?: string;
    returnType?: string;
    signature?: string;
  },
): void {
  db.prepare(`
    INSERT INTO external_symbols
      (crate_name, crate_version, symbol_name, symbol_kind, method_name, param_types, return_type, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(crate_name, crate_version, symbol_name, method_name) DO UPDATE SET
      symbol_kind = excluded.symbol_kind,
      param_types = excluded.param_types,
      return_type = excluded.return_type,
      signature = excluded.signature
  `).run(
    params.crateName,
    params.crateVersion,
    params.symbolName,
    params.symbolKind,
    params.methodName ?? '',
    params.paramTypes ?? null,
    params.returnType ?? null,
    params.signature ?? null,
  );
}

/**
 * Clear external symbols, optionally filtered by crate name.
 */
export function clearExternalSymbols(db: SqliteDatabase, crateName?: string): void {
  if (crateName) {
    db.prepare('DELETE FROM external_symbols WHERE crate_name = ?').run(crateName);
  } else {
    db.exec('DELETE FROM external_symbols');
  }
}

/**
 * Find all types that have a method with the given name.
 */
export function findTypesByMethod(
  db: SqliteDatabase,
  methodName: string,
): Array<{ symbolName: string; paramTypes: string | null }> {
  const rows = db.prepare(
    `SELECT symbol_name, param_types FROM (
       SELECT symbol_name, param_types,
         ROW_NUMBER() OVER (PARTITION BY symbol_name ORDER BY crate_version DESC) as rn
       FROM external_symbols
       WHERE method_name = ? AND method_name != ''
     ) WHERE rn = 1`
  ).all(methodName) as Array<{ symbol_name: string; param_types: string | null }>;
  return rows.map(r => ({ symbolName: r.symbol_name, paramTypes: r.param_types }));
}
