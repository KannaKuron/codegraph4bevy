/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  EdgeKind,
  UnresolvedReference,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
  isGrammarLoaded,
  loadGrammarsForLanguages,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { logWarn } from './errors';
import { FileWatcher, WatchOptions, PendingFile } from './sync';
import { indexExternalCrates } from './extraction/external-crates';

// Re-export types for consumers
export * from './types';
export { getDatabasePath } from './db';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions, PendingFile } from './sync';
export { MCPServer } from './mcp';

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

        // Re-detect frameworks now that the index is populated. The resolver
        // is constructed with createResolver() before any files exist, so
        // framework resolvers whose detect() consults the indexed file list
        // (e.g. UIKit/SwiftUI scanning for imports, swift-objc-bridge looking
        // for both Swift and ObjC files) all return false on that initial pass
        // and silently drop themselves. Re-initializing here gives them a
        // chance to see the actual project before resolution runs.
        if (result.success && result.filesIndexed > 0) {
          this.resolver.initialize();
          // Cross-file finalization (e.g. NestJS RouterModule prefixes). Runs
          // before resolution so updated names show up in subsequent reads.
          this.resolver.runPostExtract();
        }

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });

          // B4: Index external crate symbols (Bevy method signatures)
          // Runs after resolution so external symbols are available for
          // resolveReceiverType Tier 2 lookups.
          try {
            // Ensure Rust grammar is loaded before tree-sitter based shallow indexing
            if (!isGrammarLoaded('rust')) {
              await loadGrammarsForLanguages(['rust']);
            }
            const crateResult = indexExternalCrates(this.projectRoot, this.queries);
            if (crateResult.cratesIndexed > 0 || crateResult.errors.length > 0) {
              logWarn(`External crate indexing: ${crateResult.cratesIndexed} crates, ${crateResult.symbolsIndexed} symbols` +
                (crateResult.errors.length > 0 ? `, ${crateResult.errors.length} errors` : ''));
            }
          } catch {
            // Crate indexing is best-effort; failures don't block indexing
          }
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        // Cheap and non-blocking; never load-bearing for correctness.
        if (result.success && result.filesIndexed > 0) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // Cross-file finalization (e.g. NestJS RouterModule prefixes). Run on
        // every sync that touched files so edits to `app.module.ts` propagate
        // to controllers in unchanged files. The pass is idempotent and cheap
        // (regex over *.module.ts only).
        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolver.runPostExtract();
        }

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });

            // N13: Re-synthesize heuristic callback/dispatcher edges (e.g.,
            // Bevy state transitions). These cross file boundaries and were
            // cascade-deleted when the changed file's nodes were removed
            // during re-extraction.
            this.resolver.synthesizeCallbackEdges();
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async () => {
        const result = await this.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Return the watcher's current set of files that changed since the last
   * sync cycle completed. Empty when there is no active watcher.
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * Resolve when the file watcher is ready (chokidar has finished its
   * initial scan). Rejects after timeoutMs (default 10s) if the watcher
   * never becomes ready. Used by tests that need to trigger file writes
   * after the watcher is guaranteed to detect them.
   */
  async waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher?.waitUntilReady(timeoutMs);
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Active SQLite backend for this project's connection (`node-sqlite` — Node's
   * built-in real-SQLite module). Surfaced via `codegraph status` and the
   * `codegraph_status` MCP tool alongside the effective journal mode.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `codegraph status` and the `codegraph_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Find nodes that reference a given type (via type_of/references/returns edges).
   */
  findNodesByReferencedType(typeName: string, options?: SearchOptions & { edgeKinds?: EdgeKind[] }): SearchResult[] {
    return this.queries.findNodesByReferencedType(typeName, options);
  }

  /**
   * Search comments via FTS5 by text content.
   */
  searchComments(query: string, limit?: number): Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
    kind: string;
    associatedSymbol: string | null;
  }> {
    return this.queries.searchComments(query, limit);
  }

  /**
   * Find nodes that implement a given trait/interface.
   */
  findImplementors(traitName: string, options?: SearchOptions): SearchResult[] {
    return this.queries.findImplementors(traitName, options);
  }

  /**
   * Search for macro call sites by macro name.
   * Returns deduplicated call locations from unresolved macro_call references.
   */
  searchMacroCalls(name: string, limit: number = 20): Array<{ filePath: string; line: number; column: number; fromNodeId: string }> {
    // Normalize: strip trailing ! — macro names are stored without it (tree-sitter
    // parses info! as macro_name=info + bang), but users naturally search info!
    const normalized = name.endsWith('!') ? name.slice(0, -1) : name;
    const refs = this.queries.getUnresolvedByName(normalized);
    const seen = new Set<string>();
    const results: Array<{ filePath: string; line: number; column: number; fromNodeId: string }> = [];
    for (const ref of refs) {
      if (ref.referenceKind !== 'macro_call') continue;
      const key = `${ref.filePath}:${ref.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ filePath: ref.filePath ?? '', line: ref.line, column: ref.column, fromNodeId: ref.fromNodeId });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Search for method call sites by method name.
   * Returns deduplicated call locations from unresolved method_call references.
   */
  searchMethodCalls(name: string, limit: number = 30): Array<{ filePath: string; line: number; column: number; fromNodeId: string; receiverHint: string; declaredType?: string }> {
    const refs = this.queries.getUnresolvedByName(name);
    const seen = new Set<string>();
    const results: Array<{ filePath: string; line: number; column: number; fromNodeId: string; receiverHint: string; declaredType?: string }> = [];
    for (const ref of refs) {
      if (ref.referenceKind !== 'method_call') continue;
      const key = `${ref.filePath}:${ref.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Look up the corresponding calls ref for receiver context
      const callerRefs = this.queries.getUnresolvedByNode(ref.fromNodeId);
      let receiverHint = '';
      for (const cr of callerRefs) {
        if (cr.referenceKind === 'calls' && cr.line === ref.line && cr.referenceName.endsWith(`.${name}`)) {
          receiverHint = cr.referenceName.slice(0, -(name.length + 1));
          break;
        }
      }
      // Resolve declared type from the receiver variable's type_of edge
      const declaredType = receiverHint ? this.resolveReceiverType(ref.fromNodeId, receiverHint, name) : undefined;
      results.push({ filePath: ref.filePath ?? '', line: ref.line, column: ref.column, fromNodeId: ref.fromNodeId, receiverHint, declaredType });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Get unresolved references by reference name.
   * Used for finding usages of external symbols (no project-internal node).
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    return this.queries.getUnresolvedByName(name);
  }

  /**
   * Get unresolved references originating from a specific node.
   * Used for callees of external symbols.
   */
  getUnresolvedByNode(nodeId: string): UnresolvedReference[] {
    return this.queries.getUnresolvedByNode(nodeId);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string, kinds?: EdgeKind[]): Edge[] {
    return this.queries.getOutgoingEdges(nodeId, kinds);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string, kinds?: EdgeKind[]): Edge[] {
    return this.queries.getIncomingEdges(nodeId, kinds);
  }

  /**
   * Count incoming edges for a node (fast COUNT query, avoids fetching all rows).
   */
  getIncomingEdgeCount(nodeId: string, kinds?: EdgeKind[]): number {
    return this.queries.getIncomingEdgeCount(nodeId, kinds);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get all descendants of a node recursively (following contains edges).
   */
  getDescendantsRecursive(nodeId: string, maxDepth?: number): Node[] {
    return this.traverser.getDescendantsRecursive(nodeId, maxDepth);
  }

  /**
   * Extract the base type name from a Rust parameter signature.
   * Handles: "&mut Commands" → "Commands", "&mut ActionSpawnerCommands<Foo>" → "ActionSpawnerCommands",
   * "Option<&mut Commands>" → "Commands", "Commands" → "Commands".
   */
  private extractBaseTypeFromSignature(sig: string): string | undefined {
    let s = sig.trim();
    // Strip leading reference + mut: &mut, &
    s = s.replace(/^&(?:mut\s+)?/, '');
    // Unwrap Option<...>
    while (s.startsWith('Option<') && s.endsWith('>')) {
      s = s.slice(7, -1).trim();
      s = s.replace(/^&(?:mut\s+)?/, '');
    }
    // Strip trailing generic args: ActionSpawnerCommands<Foo, Bar> → ActionSpawnerCommands
    const angleIdx = s.indexOf('<');
    if (angleIdx > 0) {
      s = s.slice(0, angleIdx);
    }
    s = s.trim();
    // Only return if it looks like a type name (starts with uppercase or is a known pattern)
    if (s && /^[A-Z\p{Lu}]/u.test(s)) {
      return s;
    }
    return undefined;
  }

  /**
   * Resolve the declared type name for a variable by following type_of edges.
   * Three-tier resolution:
   *
   * Tier 1: Search all descendants (not just immediate children) for a parameter
   *         node with matching name, then follow type_of edges to get declared type.
   *         Covers: `commands: Commands`, `窗口: Single<&mut Window>`, etc.
   *
   * Tier 2: For closure parameters without type annotations (no type_of edge),
   *         look up the method being called in external_symbols to infer the type.
   *         Covers: `|父节点|` in `with_children` → `ChildBuilder`.
   *
   * Tier 3: Hardcoded fallback for well-known Bevy patterns.
   *         Covers: `with_children` → `ChildBuilder` (safety net when crate index unavailable).
   */
  private resolveReceiverType(fromNodeId: string, varName: string, methodName?: string): string | undefined {
    // ── Tier 1: Recursive parameter search with type_of / references edges ─────
    const descendants = this.traverser.getDescendantsRecursive(fromNodeId);
    for (const child of descendants) {
      if (child.kind === 'parameter' && child.name === varName) {
        // Parameter types may be stored as type_of (generic/turbofish context)
        // or references (direct type annotations). Check both.
        let typeEdges = this.queries.getOutgoingEdges(child.id, ['type_of']);
        if (typeEdges.length === 0) {
          typeEdges = this.queries.getOutgoingEdges(child.id, ['references']);
        }
        if (typeEdges.length > 0) {
          const typeNode = this.queries.getNodeById(typeEdges[0]!.target);
          if (typeNode) return typeNode.name;
        }
        // No resolved type edge (external type like ActionSpawnerCommands).
        // Parse type name from the parameter's stored signature.
        const sig = child.signature;
        if (sig) {
          const extractedType = this.extractBaseTypeFromSignature(sig);
          if (extractedType) return extractedType;
          // Tier 1.5: Closure parameter type inference from external_symbols.
          // When a closure parameter has no type annotation, its signature holds the
          // method name (stored by extractVariables in rust.ts). Look up the method
          // to find which types have it, then extract the inner param type from
          // the method's signature (e.g. impl FnOnce(&mut ChildBuilder) → ChildBuilder).
          if (sig.length > 0 && !/[<: ]/u.test(sig)) {
            const types = this.queries.findTypesByMethod(sig);
            let bestName: string | undefined;
            for (const t of types) {
              if (t.paramTypes) {
                try {
                  const paramTypes: string[] = JSON.parse(t.paramTypes);
                  for (const pt of paramTypes) {
                    let p = pt.trim();
                    if (/^&?(?:mut\s+)?self$/i.test(p)) continue;
                    p = p.replace(/^impl\s+/, '');
                    const fnMatch = p.match(/^(FnOnce|FnMut|Fn)\s*\(\s*(.+)\s*\)$/);
                    if (fnMatch) {
                      const inner = fnMatch[2]!.split(',')[0]!.trim();
                      const innerType = this.extractBaseTypeFromSignature(inner);
                      if (innerType) return innerType;
                      continue;
                    }
                    const directType = this.extractBaseTypeFromSignature(p);
                    if (directType) return directType;
                  }
                } catch (e) {
                  logWarn(`[resolveReceiverType] Failed to parse param_types for type "${t.symbolName}" with method "${sig}": ${(e as Error).message}`);
                }
              }
              // Remember the first type name as fallback, but keep checking others
              if (!bestName) bestName = t.symbolName;
            }
            if (bestName) return bestName;
          }
        }
        continue;
      }
    }

    // Also check immediate children (backward compat — non-parameter variable declarations)
    const children = this.traverser.getChildren(fromNodeId);
    for (const child of children) {
      if (child.name === varName && child.kind !== 'parameter') {
        const typeEdges = this.queries.getOutgoingEdges(child.id, ['type_of']);
        if (typeEdges.length > 0) {
          const typeNode = this.queries.getNodeById(typeEdges[0]!.target);
          if (typeNode) return typeNode.name;
        }
      }
    }

    // ── Tier 2: Generalized external symbol lookup by method name ────
    if (methodName) {
      const types = this.queries.findTypesByMethod(methodName);
      if (types.length > 0) return types[0]!.symbolName;
    }

    // ── Tier 3: Hardcoded fallback for well-known Bevy patterns ──
    // (safety net when external_symbols is empty — CI, no Cargo.lock, etc.)
    if (methodName) {
      if (methodName === 'with_children' || methodName === 'spawn_children') {
        return 'ChildBuilder';
      }
      if (methodName === 'with_related_entities') {
        return 'EntityCommands';
      }
      if (methodName === 'spawn' || methodName === 'insert' || methodName === 'remove' || methodName === 'despawn') {
        return 'EntityCommands';
      }
      if (methodName === 'entity' || methodName === 'commands' || methodName === 'id'
        || methodName === 'entry' || methodName === 'with_child'
        || methodName === 'spawn_empty' || methodName === 'spawn_batch') {
        return 'EntityCommands';
      }
      if (methodName === 'single' || methodName === 'get' || methodName === 'iter') {
        return 'Query';
      }
      if (methodName === 'iter_mut' || methodName === 'get_single' || methodName === 'query') {
        return 'Query';
      }
      if (methodName === 'send' || methodName === 'send_batch' || methodName === 'trigger') {
        return 'EventWriter';
      }
      if (methodName === 'set') {
        return 'NextState';
      }
    }

    return undefined;
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
