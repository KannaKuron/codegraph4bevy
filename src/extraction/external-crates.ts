/**
 * External Crate Shallow Indexer (B4)
 *
 * Indexes Bevy (and other Rust dependencies) by reading Cargo.toml,
 * locating crate source in ~/.cargo/registry/src/, and extracting
 * type definitions + method signatures via tree-sitter.
 *
 * The resulting data powers Tier 2 resolveReceiverType — resolving
 * closure parameter types (e.g. |parent| in with_children → ChildBuilder).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Node as SyntaxNode } from 'web-tree-sitter';
import type { QueryBuilder } from '../db/queries';
import { getParser, isGrammarLoaded } from './grammars';
import { getNodeText } from './tree-sitter-helpers';

// ── Types ────────────────────────────────────────────────────────────

export interface ExternalCrateIndex {
  types: Map<string, {
    kind: 'struct' | 'enum' | 'trait';
    methods: Map<string, string[]>; // methodName → param type names
  }>;
}

export interface IndexCratesResult {
  cratesFound: number;
  cratesIndexed: number;
  symbolsIndexed: number;
  errors: string[];
}

// ── Cargo.toml parsing ───────────────────────────────────────────────

/**
 * Parse [dependencies] section from Cargo.toml content.
 * Returns a map of crate name → version string (e.g. "0.15").
 * Handles basic TOML: quoted strings, tables, inline tables.
 */
/**
 * Strip inline comments from a TOML value string.
 * Skips characters inside quoted strings, truncates at an unquoted '#'.
 */
function stripInlineComment(value: string): string {
  let inString = false;
  let quoteChar = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === quoteChar) inString = false;
    } else {
      if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue; }
      if (ch === '#') return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function parseDependencies(content: string): Map<string, string> {
  const deps = new Map<string, string>();
  const lines = content.split('\n');
  let inDeps = false;
  let currentTableCrate: string | null = null; // for [dependencies.crate_name] tables

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect [dependencies] section or [dependencies.crate_name] sub-table
    const tableMatch = trimmed.match(/^\[dependencies\]$/);
    const subTableMatch = trimmed.match(/^\[dependencies\.(\w[\w-]*)\]$/);
    if (tableMatch) {
      inDeps = true;
      currentTableCrate = null;
      continue;
    }
    if (subTableMatch) {
      inDeps = true;
      currentTableCrate = subTableMatch[1]!;
      continue;
    }
    // Section boundary
    if (inDeps && /^\[/.test(trimmed) && !trimmed.startsWith('[dependencies')) {
      break;
    }
    if (!inDeps) continue;

    // Handle table-format dependency: version = "..." under [dependencies.crate_name]
    if (currentTableCrate) {
      const versionMatch = trimmed.match(/^version\s*=\s*"([^"]+)"/);
      if (versionMatch) {
        deps.set(currentTableCrate, versionMatch[1]!);
      }
      continue;
    }

    // Parse "crate_name = "version"" or "crate_name = { version = "...", ... }"
    const match = trimmed.match(/^(\w[\w-]*)\s*=\s*(.+)$/);
    if (!match) continue;

    const name = match[1]!;
    const value = stripInlineComment(match[2]!.trim());

    if (value.startsWith('{')) {
      // Inline table: try to extract version
      const vMatch = value.match(/version\s*=\s*"([^"]+)"/);
      if (vMatch) {
        deps.set(name, vMatch[1]!);
      }
    } else if (value.startsWith('"')) {
      // Simple string version
      deps.set(name, value.replace(/^"|"$/g, ''));
    }
  }

  return deps;
}

// ── Crate source discovery ───────────────────────────────────────────

/**
 * Locate the source directory for a crate in the cargo registry.
 * Scans ~/.cargo/registry/src/ for matching crate-version directories.
 */
function findCrateSource(name: string, version: string): string | null {
  const registrySrc = path.join(os.homedir(), '.cargo', 'registry', 'src');
  if (!fs.existsSync(registrySrc)) return null;

  // Registry structure: ~/.cargo/registry/src/<index-hash>/<name>-<version>/
  try {
    for (const indexDir of fs.readdirSync(registrySrc)) {
      const indexPath = path.join(registrySrc, indexDir);
      if (!fs.statSync(indexPath).isDirectory()) continue;

      const crateDir = path.join(indexPath, `${name}-${version}`);
      if (fs.existsSync(crateDir) && fs.statSync(crateDir).isDirectory()) {
        return crateDir;
      }
    }
  } catch {
    return null;
  }

  return null;
}

// ── Tree-sitter shallow extraction ───────────────────────────────────

/**
 * Recursively extract type names from a type annotation AST node.
 * Walks generic_type, reference_type, etc. to find type_identifier leaves.
 */
function extractTypeNamesFromNode(node: SyntaxNode, source: string, types: string[]): void {
  if (node.type === 'type_identifier') {
    const name = getNodeText(node, source);
    if (name && !types.includes(name)) {
      types.push(name);
    }
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) extractTypeNamesFromNode(child, source, types);
  }
}

/**
 * Shallow-parse a Rust source file (lib.rs) using tree-sitter to extract:
 * - pub struct / enum / trait definitions
 * - pub fn method signatures from impl blocks
 *
 * Does NOT create full graph nodes/edges — returns lightweight ExternalCrateIndex.
 */
function shallowIndexCrateSource(sourcePath: string): ExternalCrateIndex {
  const index: ExternalCrateIndex = { types: new Map() };

  if (!isGrammarLoaded('rust')) return index;

  let content: string;
  try {
    content = fs.readFileSync(sourcePath, 'utf-8');
  } catch {
    return index;
  }

  const parser = getParser('rust');
  if (!parser) return index;

  let tree = null;
  try {
    tree = parser.parse(content);
    if (!tree) return index;

    const root = tree.rootNode;

    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (!child) continue;

      if (child.type === 'struct_item' || child.type === 'enum_item' || child.type === 'trait_item') {
        // Check for pub visibility (visibility_modifier named child)
        const isPub = child.namedChildren.some(c => c.type === 'visibility_modifier');
        if (!isPub) continue;

        const nameNode = child.namedChildren.find(c => c.type === 'type_identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, content);
        if (!name) continue;

        const kind = child.type === 'struct_item' ? 'struct' : child.type === 'enum_item' ? 'enum' : 'trait';
        if (!index.types.has(name)) {
          index.types.set(name, { kind, methods: new Map() });
        }
      } else if (child.type === 'impl_item') {
        // Find the implementing type: last type_identifier before the body
        let implTypeName = '';
        for (let j = 0; j < child.namedChildCount; j++) {
          const c = child.namedChild(j);
          if (!c) continue;
          if (c.type === 'declaration_list') break;
          if (c.type === 'type_identifier') {
            implTypeName = getNodeText(c, content);
          }
        }
        if (!implTypeName) continue;

        if (!index.types.has(implTypeName)) {
          index.types.set(implTypeName, { kind: 'struct', methods: new Map() });
        }
        const entry = index.types.get(implTypeName)!;

        // Walk body for pub fn methods
        const body = child.namedChildren.find(c => c.type === 'declaration_list');
        if (!body) continue;

        for (let j = 0; j < body.namedChildCount; j++) {
          const fnNode = body.namedChild(j);
          if (!fnNode || fnNode.type !== 'function_item') continue;

          const fnIsPub = fnNode.namedChildren.some(c => c.type === 'visibility_modifier');
          if (!fnIsPub) continue;

          const fnNameNode = fnNode.namedChildren.find(c => c.type === 'identifier');
          if (!fnNameNode) continue;
          const methodName = getNodeText(fnNameNode, content);
          if (!methodName) continue;

          // Extract parameter type names
          const paramsNode = fnNode.namedChildren.find(c => c.type === 'parameters');
          const paramTypes: string[] = [];
          if (paramsNode) {
            for (let k = 0; k < paramsNode.namedChildCount; k++) {
              const param = paramsNode.namedChild(k);
              if (!param || param.type !== 'parameter') continue;

              // Skip self parameter
              const hasSelf = param.namedChildren.some(
                c => c.type === 'self' || c.type === 'self_parameter'
              );
              if (hasSelf) continue;

              // Find the type annotation (field 'type')
              const typeNode = param.namedChildren.find(
                c => c.type !== 'mutable_specifier' && c.type !== 'identifier'
              );
              if (typeNode) {
                extractTypeNamesFromNode(typeNode, content, paramTypes);
              }
            }
          }

          entry.methods.set(methodName, paramTypes);
        }
      }
    }
  } finally {
    if (tree) tree.delete();
  }

  return index;
}

// ── Cache key from Cargo.lock ─────────────────────────────────────────

/**
 * Compute a cache key from Cargo.lock content hash.
 * Avoids re-indexing crates when dependencies haven't changed.
 */
function getCargoLockHash(projectRoot: string): string | null {
  const lockPath = path.join(projectRoot, 'Cargo.lock');
  try {
    const content = fs.readFileSync(lockPath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Index external crates for a Rust project.
 *
 * 1. Reads Cargo.toml → extracts [dependencies]
 * 2. Compares Cargo.lock hash with stored cache key (skips if unchanged)
 * 3. Locates crate source in ~/.cargo/registry/src/
 * 4. Shallow-indexes each crate's lib.rs for type + method info
 * 5. Stores results in external_symbols table
 */
export function indexExternalCrates(
  projectRoot: string,
  queries: QueryBuilder,
): IndexCratesResult {
  const result: IndexCratesResult = {
    cratesFound: 0,
    cratesIndexed: 0,
    symbolsIndexed: 0,
    errors: [],
  };

  // Check for Cargo.toml
  const cargoTomlPath = path.join(projectRoot, 'Cargo.toml');
  if (!fs.existsSync(cargoTomlPath)) {
    return result; // Not a Rust project, nothing to do
  }

  // Check for cargo registry
  const registrySrc = path.join(os.homedir(), '.cargo', 'registry', 'src');
  if (!fs.existsSync(registrySrc)) {
    return result; // No cargo registry available (CI/Docker), gracefully skip
  }

  // Check Cargo.lock hash for caching
  const lockHash = getCargoLockHash(projectRoot);
  if (lockHash) {
    const cached = queries.getMetadata('cargo_lock_hash');
    if (cached === lockHash) {
      return result; // Unchanged, skip
    }
  }

  let cargoContent: string;
  try {
    cargoContent = fs.readFileSync(cargoTomlPath, 'utf-8');
  } catch (err) {
    result.errors.push(`Failed to read Cargo.toml: ${String(err)}`);
    return result;
  }

  const deps = parseDependencies(cargoContent);
  result.cratesFound = deps.size;

  let hasBevyCrates = false;

  for (const [crateName, version] of deps) {
    // Only index Bevy crates for now (the primary use case)
    // This can be expanded to other crates in the future
    const isBevy = crateName === 'bevy' || crateName.startsWith('bevy_');
    if (!isBevy) continue;

    // Clear old external symbols on first Bevy crate discovery
    if (!hasBevyCrates) {
      queries.clearExternalSymbols();
      hasBevyCrates = true;
    }

    const crateDir = findCrateSource(crateName, version);
    if (!crateDir) {
      result.errors.push(`Crate source not found: ${crateName}-${version}`);
      continue;
    }

    // Find lib.rs
    const libRsPath = path.join(crateDir, 'src', 'lib.rs');
    if (!fs.existsSync(libRsPath)) {
      result.errors.push(`lib.rs not found for ${crateName}-${version}`);
      continue;
    }

    try {
      const index = shallowIndexCrateSource(libRsPath);

      for (const [typeName, entry] of index.types) {
        queries.upsertExternalSymbol({
          crateName,
          crateVersion: version,
          symbolName: typeName,
          symbolKind: entry.kind,
        });
        result.symbolsIndexed++;

        for (const [methodName, paramTypes] of entry.methods) {
          queries.upsertExternalSymbol({
            crateName,
            crateVersion: version,
            symbolName: typeName,
            symbolKind: entry.kind,
            methodName,
            paramTypes: JSON.stringify(paramTypes),
          });
          result.symbolsIndexed++;
        }
      }

      result.cratesIndexed++;
    } catch (err) {
      result.errors.push(`Failed to index ${crateName}: ${String(err)}`);
    }
  }

  // Save cache key
  if (lockHash) {
    queries.setMetadata('cargo_lock_hash', lockHash);
  }

  return result;
}
