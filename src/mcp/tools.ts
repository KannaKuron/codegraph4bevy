/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, TaskContext, NodeKind, EdgeKind, UnresolvedReference } from '../types';
import { createHash } from 'crypto';
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath } from '../utils';
import { tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (`#### path — sym(kind), ...`). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  if (fileCount < 500) {
    return {
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: true,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 5000) {
    return {
      // Sized so ONE explore can cover a flow that centers on a god-file (e.g.
      // excalidraw's 415 KB App.tsx): the previous 2500/file returned <1% of such
      // a file, forcing the agent to Read it anyway. Per-file must also stay ≥ the
      // smaller <500 tier (3800) — the old 2500 was non-monotonic. Tokens are
      // cheap relative to a 5–10 Read round-trip spiral; favor sufficiency.
      maxOutputChars: 28000,
      defaultMaxFiles: 10,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 35000,
      defaultMaxFiles: 12,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  return {
    maxOutputChars: 38000,
    defaultMaxFiles: 14,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
  };
}

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 *
 * Why the explicit openSync + O_NOFOLLOW dance instead of plain writeFileSync:
 * tmpdir() is world-writable on Linux (mode 1777), so on a shared multi-user
 * machine any other local user can pre-create `codegraph-consulted-<hash>` as
 * a symlink pointing at a file the victim owns. The old `writeFileSync` would
 * happily follow that link and overwrite the target's contents with the ISO
 * timestamp string (CWE-59). The session-id hash provides the predictability
 * gate, but it's defense-in-depth: if a session id ever surfaces in logs,
 * argv, or telemetry the attack becomes trivial, and the right fix is to not
 * follow links from /tmp paths in the first place.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `codegraph-consulted-${hash}`);
    // Refuse to follow a pre-planted symlink at the marker path (CWE-59).
    // O_NOFOLLOW (below) is the atomic, TOCTOU-free guard on POSIX, but it is
    // `undefined` on Windows (libuv ignores it), so the bitwise-OR silently
    // drops it and openSync would follow the link. This lstat check closes that
    // gap cross-platform; ENOENT (path is free) falls through to create it.
    try {
      if (lstatSync(markerPath).isSymbolicLink()) return;
    } catch {
      // No existing entry (or stat failed) — nothing to refuse; proceed.
    }
    // O_NOFOLLOW makes openSync throw ELOOP if markerPath is already a symlink.
    // O_CREAT + O_TRUNC keep the original "create-or-overwrite" semantics, and
    // mode 0o600 prevents readback by other local users (the marker payload is
    // benign, but narrowing the exposure costs nothing).
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
    const fd = openSync(markerPath, flags, 0o600);
    try {
      writeSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silently fail - don't break MCP on marker write failure. ELOOP from a
    // planted symlink lands here too, which is the intended behavior: refuse
    // to write rather than overwrite an attacker-chosen target.
  }
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: '其他已初始化 .codegraph/ 的项目路径。省略则使用当前项目。用于查询其他代码库。',
};

/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_context as the primary tool,
 * and only use other tools for targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: '按名称快速搜索符号。只返回位置（不含源码）。需要全面的任务上下文时用 codegraph_context。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '符号名或部分名称（如 "auth"、"signIn"、"UserService"）',
        },
        kind: {
          type: 'string',
          description: '按节点类型过滤',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component', 'comment', 'macro', 'method_call'],
        },
        referencesType: {
          type: 'string',
          description: '查找引用此类型的所有符号（通过 type_of/references/returns 边）。设置后 query 仅作 fallback。',
        },
        mutability: {
          type: 'string',
          description: 'referencesType 时过滤借用模式："mut"（可变借用，ResMut）、"shared"（共享借用，Res、&T）、"owning"（拥有值，返回类型）。用于区分资源的读写者。',
          enum: ['mut', 'shared', 'owning'],
        },
        impl_for: {
          type: 'string',
          description: '查找实现指定 trait/interface 的所有类型（通过 implements 边或未解析引用）。设置后 query 仅作 fallback。',
        },
        limit: {
          type: 'number',
          description: '最大结果数（默认: 10）',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'codegraph_context',
    description: '主工具 — 任何"X 怎么工作"、架构、功能或 bug 上下文问题都先调这个。组合 search + node + callers + callees，一次调用返回入口点、相关符号和关键代码 — 通常无需进一步搜索/Read/Grep。优于链式 codegraph_search + codegraph_node 和 codegraph_explore。注意：提供的是代码上下文，不是产品需求；新功能仍需与用户确认 UX/边界条件。',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要构建上下文的任务、bug 或功能描述',
        },
        maxNodes: {
          type: 'number',
          description: '包含的最大符号数（默认: 20）',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: '包含关键符号的代码片段（默认: true）',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  {
    name: 'codegraph_callers',
    description: '查找调用指定符号的所有函数/方法。返回调用点行号和单行源码片段。加 "kind" 参数可查非调用关系：references、type_of、pattern_match、instantiates 及框架特定边。include_external 显示外部未解析引用。支持 symbols 数组批量查询。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要查找调用者的函数、方法或类名',
        },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '批量查询：多个符号名，结果按符号分组',
        },
        kind: {
          type: 'string',
          description: 'Edge kind 过滤器。不指定时只返回 callers（calls 边）。指定后返回该类型的所有用法（含 incoming 和 outgoing）。通用类型："references"、"type_of"、"pattern_match"、"instantiates"、"contains"。框架特定边：runs_in、on_enter、on_exit、registers_resource、registers_message、contains_plugin。',
          enum: ['calls', 'references', 'type_of', 'instantiates', 'contains', 'pattern_match', 'runs_in', 'on_enter', 'on_exit', 'registers_resource', 'registers_message', 'contains_plugin', 'all'],
        },
        mutability: {
          type: 'string',
          description: '配合 kind="type_of" 过滤借用模式："mut"（可变借用，ResMut、&mut）、"shared"（共享借用，Res、&T）、"owning"（拥有值，返回类型）。用于区分类型的读写者。',
          enum: ['mut', 'shared', 'owning'],
        },
        include_external: {
          type: 'boolean',
          description: '包含对当前索引中无定义节点的符号的引用。即第三方依赖、标准库、框架 API 等在项目中没有源码的符号。默认: false。',
          default: false,
        },
        limit: {
          type: 'number',
          description: '返回的最大调用者数（默认: 20）',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: [],
      anyOf: [
        { required: ['symbol'] },
        { required: ['symbols'] },
      ],
    },
  },
  {
    name: 'codegraph_callees',
    description: '查找指定符号调用的所有函数/方法。返回调用点行号和单行源码片段。include_external 显示对项目外符号的调用（框架 API、第三方库、标准库宏等）。支持 symbols 数组批量查询。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要查找被调用者的函数、方法或类名',
        },
        include_external: {
          type: 'boolean',
          description: '包含对当前索引中无定义节点的符号的调用。即第三方依赖、标准库、框架 API、宏等在项目中没有源码的符号。默认: true。设为 false 只显示项目内有定义节点的被调用者。',
          default: true,
        },
        limit: {
          type: 'number',
          description: '返回的最大被调用者数（默认: 20）',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_symbol_info',
    description: '聚合符号信息 — 一次返回：定义位置/签名、所有入边（按种类分组计数+前5条详情）、出向调用、影响半径。替代多次 callers(kind=references/type_of/pattern_match/...) 调用。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要分析的符号名',
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_impact',
    description: '分析修改某符号的影响半径 — 改了会破坏什么？显示可能受影响的代码，按依赖距离排序。includeCode 内联受影响符号的源码。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要分析影响的符号名',
        },
        depth: {
          type: 'number',
          description: '遍历依赖的层数（默认: 2）',
          default: 2,
        },
        includeCode: {
          type: 'boolean',
          description: '包含一级节点的源码片段（默认: false）。每段上限 8 行/400 字符。',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_node',
    description: '获取一个符号的详情（位置、签名、文档）及上下游 — 调用什么、被谁调用，各带 file:line。includeCode=true 返回函数体/成员概览源码。用于逐跳遍历调用图。批量总览用 codegraph_explore，深入具体路径用 node。返回的源码与 Read 逐字节一致。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要获取详情的符号名',
        },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '批量查询：多个符号名获取详情。结果按符号分组。替代多次调用 codegraph_node。',
        },
        includeCode: {
          type: 'boolean',
          description: '包含完整源码（默认: false 以最小化上下文）',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: [],
      anyOf: [
        { required: ['symbol'] },
        { required: ['symbols'] },
      ],
    },
  },
  {
    name: 'codegraph_explore',
    description: '一次有上限调用返回多个相关符号的源码（按文件分组）和关系图。高效查看多个相关符号的首选 — 优于多次 codegraph_node 或 Read（每次单独调用重读整个上下文，10 次 node 远比 1 次 explore 开销大）。codegraph_context 后需要看实际源码时使用。用具体符号/文件/代码术语查询，不要用自然语言句子 — 先用 codegraph_search 找名字。好的查询："renderStaticScene drawElementOnCanvas ShapeCache"。差的查询："agent prompts are loaded"。返回的是原始源码（与 Read 逐字节一致），带行号，非摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要探索的符号名、文件名或短代码术语（如 "AuthService loginUser session-manager"）。先用 codegraph_search 找相关名。',
        },
        path: {
          type: 'string',
          description: '限定探索此目录下的文件（如 "src/components"）',
        },
        maxFiles: {
          type: 'number',
          description: '包含源码的最大文件数（默认: 12）',
          default: 12,
        },
        sourceOnly: {
          type: 'boolean',
          description: '跳过关系图，只返回源码（默认: false）',
          default: false,
        },
        strict: {
          type: 'boolean',
          description: '为 true 时结果仅限 path 目录下的文件（默认: false）',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'codegraph_status',
    description: '获取 CodeGraph 索引状态。返回已索引文件数、节点数、边数等统计信息及当前使用的数据库后端（better-sqlite3 或 WASM）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_files',
    description: '从索引返回项目文件结构。展示所有已索引文件的树状视图及元数据（语言、符号数）。比 glob/文件系统扫描快得多。探索项目结构、找文件、理解代码库组织时先用这个。symbols: true 包含每个文件的顶层符号名。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '过滤此目录下的文件（如 "src/components"）。未指定返回所有文件。',
        },
        pattern: {
          type: 'string',
          description: '按 glob 模式过滤文件（如 "*.tsx"、"**/*.test.ts"）',
        },
        format: {
          type: 'string',
          description: '输出格式："tree"（树状，默认）、"flat"（平铺）、"grouped"（按语言分组）',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: '包含文件元数据如语言和符号数（默认: true）',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: '显示的最大目录深度（默认: 无限制）',
        },
        symbols: {
          type: 'boolean',
          description: '包含每个文件的顶层符号名和类型（默认: false）',
          default: false,
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_trace',
    description: '追踪两个符号之间的调用路径 — "from 如何到达/变成 to？" 一次调用返回完整函数链（每跳带 file:line 和内联源码及目的地本身的被调用者）。这是 grep/Read 结构上无法做到的 — 没有"从 A 到 B 的路径"这种文本模式。适用于流程问题 — 更新如何触发渲染、请求如何到达处理器。如无静态路径则链在动态调度处断开（回调/描述符/元类）；工具会指出断开点。',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: '流程起始符号（如 "QuerySet"、"handleRequest"）',
        },
        to: {
          type: 'string',
          description: '流程目标符号（如 "execute_sql"、"render"）',
        },
        includeCode: {
          type: 'boolean',
          description: '包含每跳源码（默认: true）。false 仅返回符号名。',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['from', 'to'],
    },
  },
];

/**
 * Banner prepended when a read-tool response references files the watcher
 * has seen change but hasn't synced yet. Only lists files actually mentioned
 * in this response; see {@link formatStaleFooter} for the rest.
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their codegraph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened CodeGraph instances for cross-project queries
  private projectCache: Map<string, CodeGraph> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .codegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();

  constructor(private cg: CodeGraph | null) {}

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
    this.worktreeMismatchCache.clear();
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
   * env var (comma-separated short names, e.g. "trace,search,node,context").
   * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
   * trim the tool surface without rebuilding the client config; the ablated
   * tool is then truly absent from ListTools rather than merely denied on call.
   * Matching is on the short form, so "trace" and "codegraph_trace" both work.
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.CODEGRAPH_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const short = (s: string) => s.trim().replace(/^codegraph_/, '');
    const set = new Set(raw.split(',').map(short).filter(Boolean));
    return set.size ? set : null;
  }

  /** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any). */
  private isToolAllowed(name: string): boolean {
    const allow = this.toolAllowlist();
    return !allow || allow.has(name.replace(/^codegraph_/, ''));
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    const visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, '')))
      : tools;
    if (!this.cg) return visible;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      return visible.map(tool => {
        if (tool.name === 'codegraph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return visible;
    }
  }

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new Error(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          'The index is likely fine — this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]'
        );
      }
      return this.cg;
    }

    // Check cache first (using original path as key)
    if (this.projectCache.has(projectPath)) {
      return this.projectCache.get(projectPath)!;
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new Error(pathError);
      }
    }

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; on the wasm backend (no WAL) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. Deliberately
    // not cached under projectPath — the server owns and closes the default
    // instance, so routing it through projectCache.closeAll() would double-close it.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.cg;
    }

    // When this.cg is null (not yet initialized after engine startup),
    // check projectCache for any existing instance at the same root so
    // we don't open a duplicate that the engine will open moments later.
    if (!this.cg) {
      for (const [, cachedCg] of this.projectCache) {
        try {
          if (cachedCg.getProjectRoot() === resolvedRoot) {
            return cachedCg;
          }
        } catch { /* instance may be closed */ }
      }
    }

    // Check if we already have this resolved root cached (different path, same project)
    if (this.projectCache.has(resolvedRoot)) {
      const cg = this.projectCache.get(resolvedRoot)!;
      // Cache under original path too for faster future lookups
      this.projectCache.set(projectPath, cg);
      return cg;
    }

    // Open and cache under both paths
    const cg = CodeGraph.openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) {
      this.projectCache.set(projectPath, cg);
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    const closed = new Set<CodeGraph>();
    for (const cg of this.projectCache.values()) {
      if (!closed.has(cg)) {
        closed.add(cg);
        cg.close();
      }
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();
    const cached = this.worktreeMismatchCache.get(startPath);
    if (cached !== undefined) return cached;

    let mismatch: WorktreeIndexMismatch | null = null;
    try {
      mismatch = detectWorktreeIndexMismatch(startPath, this.getCodeGraph(projectPath).getProjectRoot());
      this.worktreeMismatchCache.set(startPath, mismatch);
    } catch {
      // No resolvable project (or any other resolution error) → don't cache;
      // a later retry (e.g. lazy init) may succeed.
      return null;
    }
    return mismatch;
  }

  /**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's. Without this, an agent in a nested worktree silently trusts
   * main-branch results. No-op on error results and when there is no mismatch.
   * `codegraph_status` is excluded — it embeds its own verbose warning.
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * between sync cycles; this inspects its pending set and prepends a
   * compact banner when the response references files that changed since
   * the last index refresh. A footer covers pending files NOT in the
   * response, giving the agent project-wide freshness awareness.
   */
  private withStalenessNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;

    let cg: CodeGraph;
    try {
      cg = this.getCodeGraph(projectPath);
    } catch {
      return result;
    }

    // Cross-project projectPath calls open a cached CodeGraph WITHOUT a
    // watcher. When the cross-project path happens to be the same project
    // as the default cg, prefer the default so pendingFiles (only populated
    // by the default's watcher) is non-empty when there are pending edits.
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())
          // On macOS /var is a symlink to /private/var — resolvePath
          // normalises but doesn't resolve symlinks, so two instances
          // pointing at the same real directory may compare as different.
          // realpathSync resolves that; fall back to resolvePath on error.
          || (() => { try { return realpathSync(this.cg!.getProjectRoot()) === realpathSync(cg.getProjectRoot()); } catch { return false; } })();
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot may throw on a closed instance */
      }
    }

    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    const elsewhere: PendingFile[] = [];
    for (const p of pending) {
      // \b word-boundary match around the escaped path avoids false
      // positives on short names ("app" in "application") while matching
      // paths inside markdown (**path**, `path`, path:line). File paths
      // use ASCII characters so \b works correctly here.
      const escaped = p.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\b' + escaped + '\\b').test(text)) inResponse.push(p);
      else elsewhere.push(p);
    }

    let banner = '';
    if (inResponse.length > 0) {
      banner = formatStaleBanner(inResponse);
    }
    let footer = '';
    if (elsewhere.length > 0) {
      footer = formatStaleFooter(elsewhere);
    }
    if (!banner && !footer) return result;

    const composed = [banner, text, footer].filter(Boolean).join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Honor the optional tool allowlist (CODEGRAPH_MCP_TOOLS): a trimmed
      // surface rejects ablated tools defensively even if a client cached them.
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via CODEGRAPH_MCP_TOOLS`);
      }
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // The `path` and `pattern` properties used by codegraph_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      // Read tools resolve through a single result variable so cross-cutting
      // notices — worktree-index mismatch — can be applied in one place.
      // status embeds its own verbose worktree warning.
      let result: ToolResult;
      switch (toolName) {
        case 'codegraph_search':
          result = await this.handleSearch(args); break;
        case 'codegraph_context':
          result = await this.handleContext(args); break;
        case 'codegraph_callers':
          result = await this.handleCallers(args); break;
        case 'codegraph_callees':
          result = await this.handleCallees(args); break;
        case 'codegraph_symbol_info':
          result = await this.handleSymbolInfo(args); break;
        case 'codegraph_impact':
          result = await this.handleImpact(args); break;
        case 'codegraph_explore':
          result = await this.handleExplore(args); break;
        case 'codegraph_node':
          result = await this.handleNode(args); break;
        case 'codegraph_status':
          return await this.handleStatus(args);
        case 'codegraph_files':
          result = await this.handleFiles(args); break;
        case 'codegraph_trace':
          result = await this.handleTrace(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      return this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const kind = args.kind as string | undefined;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);
    const referencesType = args.referencesType as string | undefined;
    const implFor = args.impl_for as string | undefined;

    let results: SearchResult[];
    if (kind === 'comment') {
      // Comment search via FTS5 — directly query comments table
      const commentResults = cg.searchComments(query, limit);
      if (commentResults.length === 0) {
        return this.textResult(`No comments found for "${query}"`);
      }
      const lines: string[] = [
        `## Comment Search: "${query}" (${commentResults.length} found)`,
        '',
      ];
      for (const c of commentResults) {
        const symbolNote = c.associatedSymbol ? ` [${c.associatedSymbol}]` : '';
        lines.push(`**${c.filePath}:${c.startLine}** (${c.kind})${symbolNote}`);
        lines.push(`> ${c.text.length > 200 ? c.text.slice(0, 197) + '…' : c.text}`);
        lines.push('');
      }
      return this.textResult(this.truncateOutput(lines.join('\n')));
    } else if (kind === 'macro') {
      // Macro call search — find all call sites of a specific macro (e.g., info!, println!)
      const macroCalls = cg.searchMacroCalls(query, limit);
      if (macroCalls.length === 0) {
        return this.textResult(`No macro invocations of "${query}" found`);
      }
      const byFile = new Map<string, typeof macroCalls>();
      for (const mc of macroCalls) {
        const arr = byFile.get(mc.filePath) || [];
        arr.push(mc);
        byFile.set(mc.filePath, arr);
      }
      const lines: string[] = [
        `## Macro invocations of "${query}" (${macroCalls.length} found)`,
        '',
      ];
      for (const [file, calls] of byFile) {
        lines.push(`**${file}:**`);
        for (const c of calls) {
          lines.push(`- line ${c.line}:${c.column}`);
        }
        lines.push('');
      }
      return this.textResult(this.truncateOutput(lines.join('\n')));
    } else if (kind === 'method_call') {
      // Method call search — find all .method() call sites across the project
      const methodCalls = cg.searchMethodCalls(query, limit);
      if (methodCalls.length === 0) {
        return this.textResult(`No method calls "${query}" found`);
      }
      // Group by declared type (resolved from type_of edges), falling back
      // to receiverHint (variable name from the call site).
      const byReceiver = new Map<string, typeof methodCalls>();
      for (const mc of methodCalls) {
        const key = mc.declaredType || mc.receiverHint || '(unknown)';
        const arr = byReceiver.get(key) || [];
        arr.push(mc);
        byReceiver.set(key, arr);
      }
      const lines: string[] = [
        `## Method calls "${query}" (${methodCalls.length} found)`,
        '',
      ];
      for (const [receiver, calls] of byReceiver) {
        lines.push(`### ${receiver}::${query} (${calls.length})`);
        for (const c of calls) {
          lines.push(`- ${c.filePath}:${c.line}`);
        }
        lines.push('');
      }
      return this.textResult(this.truncateOutput(lines.join('\n')));
    } else if (implFor) {
      results = cg.findImplementors(implFor, {
        limit,
        kinds: kind ? [kind as NodeKind] : undefined,
      });
      if (results.length === 0) {
        results = cg.searchNodes(`implements ${implFor}`, {
          limit,
          kinds: kind ? [kind as NodeKind] : undefined,
        });
      }
    } else if (referencesType) {
      // When mutability filter is active, fetch more results since many
      // may be filtered out. The final slice respects the user's limit.
      const mutability = args.mutability as string | undefined;
      const fetchLimit = mutability ? Math.max(limit * 3, 100) : limit;
      results = cg.findNodesByReferencedType(referencesType, {
        limit: fetchLimit,
        kinds: kind ? [kind as NodeKind] : undefined,
      });
      if (mutability && (mutability === 'mut' || mutability === 'shared' || mutability === 'owning')) {
        results = results.filter(r => this.classifyMutability(r.node.signature, referencesType) === mutability);
        results = results.slice(0, limit);
      }
      if (results.length === 0) {
        results = cg.searchNodes(query, {
          limit,
          kinds: kind ? [kind as NodeKind] : undefined,
        });
      }
    } else {
      results = cg.searchNodes(query, {
        limit,
        kinds: kind ? [kind as NodeKind] : undefined,
      });
    }

    if (results.length === 0) {
      let label: string;
      if (implFor) {
        label = `No implementors found for trait "${implFor}"`;
      } else if (referencesType) {
        label = `No results found for references to type "${referencesType}"`;
      } else {
        label = `No results found for "${query}"`;
      }
      return this.textResult(label);
    }

    const formatted = this.formatSearchResults(results);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_context
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const task = this.validateString(args.task, 'task');
    if (typeof task !== 'string') return task;

    // Mark session as consulted (enables Grep/Glob/Bash)
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      markSessionConsulted(sessionId);
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const maxNodes = (args.maxNodes as number) || 20;
    const includeCode = args.includeCode !== false;

    const context = await cg.buildContext(task, {
      maxNodes,
      includeCode,
      format: 'markdown',
    });

    // Detect if this looks like a feature request (vs bug fix or exploration)
    const isFeatureQuery = this.looksLikeFeatureRequest(task);
    const reminder = isFeatureQuery
      ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria'
      : '';

    // buildContext returns string when format is 'markdown'
    if (typeof context === 'string') {
      return this.textResult(this.truncateOutput(context + reminder));
    }

    // If it returns TaskContext, format it
    return this.textResult(this.truncateOutput(this.formatTaskContext(context) + reminder));
  }

  /**
   * Heuristic to detect if a query looks like a feature request
   */
  private looksLikeFeatureRequest(task: string): boolean {
    const featureKeywords = [
      'add', 'create', 'implement', 'build', 'enable', 'allow',
      'new feature', 'support for', 'ability to', 'want to',
      'should be able', 'need to add', 'swap', 'edit', 'modify'
    ];
    const bugKeywords = [
      'fix', 'bug', 'error', 'broken', 'crash', 'issue', 'problem',
      'not working', 'fails', 'undefined', 'null'
    ];
    const explorationKeywords = [
      'how does', 'where is', 'what is', 'find', 'show me',
      'explain', 'understand', 'explore'
    ];

    const lowerTask = task.toLowerCase();

    // If it's clearly a bug or exploration, not a feature
    if (bugKeywords.some(k => lowerTask.includes(k))) return false;
    if (explorationKeywords.some(k => lowerTask.includes(k))) return false;

    // If it matches feature keywords, it's likely a feature request
    return featureKeywords.some(k => lowerTask.includes(k));
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const kindFilter = args.kind as string | undefined;
    const mutability = args.mutability as string | undefined;

    // Batch mode: symbols array
    const symbolsArr = args.symbols as string[] | undefined;
    if (symbolsArr && Array.isArray(symbolsArr) && symbolsArr.length > 0) {
      const cg = this.getCodeGraph(args.projectPath as string | undefined);
      return kindFilter
        ? this.handleBatchUsagesMode(cg, symbolsArr, limit, kindFilter, mutability)
        : this.handleBatchCallers(cg, symbolsArr, limit);
    }

    if (args.symbols !== undefined && !Array.isArray(args.symbols)) {
      return this.errorResult('symbols must be an array of strings, e.g. symbols: ["X","Y","Z"]');
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);

    // Kind mode: general usages query (incoming + outgoing)
    if (kindFilter) {
      return this.handleCallersWithKind(cg, symbol, limit, kindFilter, mutability);
    }

    // Default mode: callers (calls edges + call-site snippets)
    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      // include_external: check unresolved refs even when no project symbol matches
      const includeExternal = args.include_external === true;
      if (includeExternal) {
        const unresolved = cg.getUnresolvedByName(symbol);
        if (unresolved.length > 0) {
          return this.formatExternalCallers(unresolved, symbol, limit);
        }
      }
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Collect call sites: each entry is (caller node, edge with call-site line).
    const callSites: Array<{ caller: Node; edge: Edge }> = [];
    const seen = new Set<string>();
    for (const node of allMatches.nodes) {
      for (const c of cg.getCallers(node.id)) {
        const key = `${c.node.id}:${c.edge.line ?? c.node.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          callSites.push({ caller: c.node, edge: c.edge });
        }
      }
    }

    // include_external: supplement with unresolved references.
    //
    // "external" means the referenced symbol has no node in the current
    // .codegraph/ index. This is determined by where codegraph init was run,
    // not by the project boundary:
    //   - init at repo root → all submodules/crates are "internal"
    //   - init at subdirectory → sibling modules are "external"
    //   - third-party deps, stdlib, macros → always "external"
    //
    // Language-agnostic: the same rule applies to Java, C++, Rust, Python, etc.
    // A symbol is internal iff it has a node in the index.
    const includeExternal = args.include_external === true;
    const externalCallers: Array<{ name: string; line: number; kind: string; filePath: string }> = [];
    if (includeExternal) {
      const seenExt = new Set<string>();
      const unresolved = cg.getUnresolvedByName(symbol);
      for (const ref of unresolved) {
        if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'references'
            && ref.referenceKind !== 'type_of' && ref.referenceKind !== 'macro_call' && ref.referenceKind !== 'pattern_match') continue;
        const srcNode = cg.getNode(ref.fromNodeId);
        if (!srcNode) continue;
        const key = `ext:${ref.fromNodeId}:${ref.referenceKind}:${ref.line}`;
        if (seenExt.has(key)) continue;
        seenExt.add(key);
        externalCallers.push({
          name: ref.referenceName,
          line: ref.line,
          kind: 'external',
          filePath: ref.filePath ?? srcNode.filePath,
        });
      }
    }

    const totalCallers = callSites.length + externalCallers.length;
    if (totalCallers === 0) {
      return this.textResult(`No callers found for "${symbol}"${allMatches.note}`);
    }

    // Read source snippets for call-site lines
    const fileCache = new Map<string, string[]>();

    const shownResolved = callSites.slice(0, limit);
    const EXTERNAL_SUB_LIMIT = 10;
    const shownExternal = externalCallers.slice(0, EXTERNAL_SUB_LIMIT);
    const shownTotal = shownResolved.length + shownExternal.length;
    const lines: string[] = [
      `## Callers of "${symbol}" (${shownTotal} shown, ${totalCallers} total)`,
      '',
    ];
    for (const cs of shownResolved) {
      const defLine = cs.caller.startLine ? `:${cs.caller.startLine}` : '';
      const callLine = cs.edge.line ?? cs.caller.startLine;
      const fileRef = `${cs.caller.filePath}:${callLine}`;
      const snippet = this.sourceLineAt(cg, fileRef, fileCache);
      lines.push(`- **${cs.caller.name}** (${cs.caller.kind})`);
      lines.push(`  def: ${cs.caller.filePath}${defLine}`);
      lines.push(`  call: ${cs.caller.filePath}:${callLine}${snippet ? ` — \`${snippet}\`` : ''}`);
      lines.push('');
    }
    for (const ext of shownExternal) {
      lines.push(`- **${ext.name}** (external)`);
      lines.push(`  call: ${ext.filePath}:${ext.line}`);
      lines.push('');
    }

    if (totalCallers > shownTotal) {
      lines.push(`... and ${totalCallers - shownTotal} more callers`);
    }

    lines.push(allMatches.note);
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Handle callers with a kind filter — general usages mode.
   * Checks both incoming and outgoing edges for the specified kind.
   */
  private handleCallersWithKind(cg: CodeGraph, symbol: string, limit: number, kindFilter: string, mutability?: string): ToolResult {
    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }
    const exactMatch = allMatches.nodes.some(n => this.matchesSymbol(n, symbol));
    if (!exactMatch) {
      const unresolvedResult = this.handleUsagesFromUnresolved(cg, symbol, limit, kindFilter);
      if (unresolvedResult !== null) return unresolvedResult;
    }

    // Expand container nodes (enum, struct, trait, class, interface) to include
    // their children — this fixes enum references returning 0 (B2) by querying
    // variant-level edges too.
    const CONTAINER_KINDS = new Set(['enum', 'struct', 'trait', 'class', 'interface']);
    const nodesToQuery: Node[] = [...allMatches.nodes];
    for (const node of allMatches.nodes) {
      if (CONTAINER_KINDS.has(node.kind)) {
        for (const child of cg.getChildren(node.id)) {
          if (!nodesToQuery.some(n => n.id === child.id)) {
            nodesToQuery.push(child);
          }
        }
      }
    }

    const seen = new Set<string>();
    const usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }> = [];
    // kind="all": no edge kind filter — collect all edge kinds
    const edgeKinds: EdgeKind[] | undefined = kindFilter === 'all' ? undefined : [kindFilter as EdgeKind];

    for (const node of nodesToQuery) {
      // Incoming: node is the TARGET
      for (const edge of cg.getIncomingEdges(node.id, edgeKinds)) {
        const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceNode = cg.getNode(edge.source);
        if (sourceNode) {
          usages.push({ sourceNode, targetNode: node, edgeKind: edge.kind, line: edge.line ?? sourceNode.startLine });
        }
      }
      // Outgoing: node is the SOURCE
      for (const edge of cg.getOutgoingEdges(node.id)) {
        if (edgeKinds !== undefined && !edgeKinds.includes(edge.kind)) continue;
        const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const targetNode = cg.getNode(edge.target);
        if (targetNode) {
          usages.push({ sourceNode: node, targetNode, edgeKind: edge.kind, line: edge.line ?? node.startLine });
        }
      }
    }

    if (usages.length === 0) {
      return this.textResult(`No usages of kind "${kindFilter}" found for "${symbol}"${allMatches.note}`);
    }

    // Mutability filter for type_of queries — classify each usage by its
    // borrowing pattern (mut/shared/owning) and keep only matching ones.
    if (mutability && (mutability === 'mut' || mutability === 'shared' || mutability === 'owning')) {
      const filtered: typeof usages = [];
      for (const u of usages) {
        if (this.classifyMutability(u.sourceNode.signature, symbol) === mutability) {
          filtered.push(u);
        }
      }
      usages.length = 0;
      usages.push(...filtered.slice(0, limit));
    }

    if (usages.length === 0) {
      return this.textResult(`No usages of kind "${kindFilter}" with mutability="${mutability}" found for "${symbol}"${allMatches.note}`);
    }

    // kind="all": group by edgeKind for structured output
    if (kindFilter === 'all') {
      return this.formatAllKindUsages(usages, symbol, limit, allMatches.note);
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
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Format usages grouped by edge kind for kind="all" output.
   */
  private formatAllKindUsages(
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
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Batch mode for kind-filtered callers (general usages).
   */
  private handleBatchUsagesMode(cg: CodeGraph, symbols: string[], limit: number, kindFilter: string, mutability?: string): ToolResult {
    const batchLimit = Math.min(symbols.length, 20);
    const lines: string[] = [`## Batch ${kindFilter} Usages (${batchLimit} symbols)`, ''];
    let totalUsages = 0;

    for (const symbol of symbols.slice(0, batchLimit)) {
      const valid = this.validateString(symbol, 'symbols');
      if (typeof valid !== 'string') {
        lines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
        lines.push('');
        continue;
      }
      const allMatches = this.findAllSymbols(cg, valid);
      if (allMatches.nodes.length === 0) {
        const unresolvedResult = this.handleUsagesFromUnresolved(cg, valid, Math.max(3, Math.ceil(limit / batchLimit)), kindFilter);
        if (unresolvedResult !== null) {
          lines.push((unresolvedResult.content[0] as { type: 'text'; text: string }).text);
          lines.push('');
        } else {
          lines.push(`### ${valid}: not found`); lines.push('');
        }
        continue;
      }
      const exactMatch = allMatches.nodes.some(n => this.matchesSymbol(n, valid));
      if (!exactMatch) {
        const unresolvedResult = this.handleUsagesFromUnresolved(cg, valid, Math.max(3, Math.ceil(limit / batchLimit)), kindFilter);
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
          for (const child of cg.getChildren(node.id)) {
            if (!nodesToQuery.some(n => n.id === child.id)) {
              nodesToQuery.push(child);
            }
          }
        }
      }

      const seen = new Set<string>();
      const usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }> = [];
      const edgeKinds: EdgeKind[] | undefined = kindFilter === 'all' ? undefined : [kindFilter as EdgeKind];
      for (const node of nodesToQuery) {
        for (const edge of cg.getIncomingEdges(node.id, edgeKinds)) {
          const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sourceNode = cg.getNode(edge.source);
          if (sourceNode) { usages.push({ sourceNode, targetNode: node, edgeKind: edge.kind, line: edge.line ?? sourceNode.startLine }); }
        }
        for (const edge of cg.getOutgoingEdges(node.id)) {
          if (edgeKinds !== undefined && !edgeKinds.includes(edge.kind)) continue;
          const key = `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const targetNode = cg.getNode(edge.target);
          if (targetNode) { usages.push({ sourceNode: node, targetNode, edgeKind: edge.kind, line: edge.line ?? node.startLine }); }
        }
      }

      if (mutability && (mutability === 'mut' || mutability === 'shared' || mutability === 'owning')) {
        const filtered: typeof usages = [];
        for (const u of usages) {
          if (this.classifyMutability(u.sourceNode.signature, valid) === mutability) {
            filtered.push(u);
          }
        }
        usages.length = 0;
        usages.push(...filtered);
      }

      const perLimit = Math.max(3, Math.ceil(limit / batchLimit));
      lines.push(this.formatUsageResults(valid, usages, perLimit));
      lines.push('');
      if (allMatches.note) lines.push(allMatches.note);
      totalUsages += usages.length;
    }
    lines.push('---');
    lines.push(`Total: ${totalUsages} usages across ${batchLimit} symbols`);
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Handle batch codegraph_callers — multiple symbols in one call
   */
  private handleBatchCallers(cg: CodeGraph, symbols: string[], limit: number): ToolResult {
    const batchLimit = Math.min(symbols.length, 20);
    const allLines: string[] = [`## Batch Callers (${batchLimit} symbols)`, ''];
    const fileCache = new Map<string, string[]>();
    let totalCallers = 0;

    for (const symbol of symbols.slice(0, batchLimit)) {
      const valid = this.validateString(symbol, 'symbols');
      if (typeof valid !== 'string') {
        allLines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
        allLines.push('');
        continue;
      }
      const allMatches = this.findAllSymbols(cg, valid);
      if (allMatches.nodes.length === 0) {
        allLines.push(`### ${valid}: not found`);
        allLines.push('');
        continue;
      }

      const callSites: Array<{ caller: Node; edge: Edge }> = [];
      const seen = new Set<string>();
      for (const node of allMatches.nodes) {
        for (const c of cg.getCallers(node.id)) {
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
        const snippet = this.sourceLineAt(cg, fileRef, fileCache);
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
    return this.textResult(this.truncateOutput(allLines.join('\n')));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const includeExternal = args.include_external !== false; // default true

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Collect call sites with edge line info
    const callSites: Array<{ callee: Node; edge: Edge }> = [];
    const seen = new Set<string>();
    for (const node of allMatches.nodes) {
      for (const c of cg.getCallees(node.id)) {
        const key = `${c.node.id}:${c.edge.line ?? c.node.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          callSites.push({ callee: c.node, edge: c.edge });
        }
      }
    }

    // When include_external, supplement with unresolved calls refs for each
    // matched node — external symbols (e.g. Bevy APIs) have no project node
    // and are missing from the resolved edges above.
    const externalCallees: Array<{ name: string; line: number; kind: string; filePath: string }> = [];
    if (includeExternal) {
      // Per-source-node resolved callee names for dedup (see Fix #3)
      const resolvedBySource = new Map<string, Set<string>>();
      for (const cs of callSites) {
        let s = resolvedBySource.get(cs.edge.source);
        if (!s) { s = new Set(); resolvedBySource.set(cs.edge.source, s); }
        s.add(cs.callee.name);
      }

      for (const node of allMatches.nodes) {
        const localResolved = resolvedBySource.get(node.id) ?? new Set<string>();
        const unresolved = cg.getUnresolvedByNode(node.id);
        for (const ref of unresolved) {
          if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'macro_call') continue;
          if (localResolved.has(ref.referenceName)) continue;
          const key = `ext:${ref.referenceName}:${ref.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          externalCallees.push({
            name: ref.referenceName,
            line: ref.line,
            kind: ref.referenceKind === 'macro_call' ? 'external macro' : 'external',
            filePath: ref.filePath ?? node.filePath,
          });
        }
      }
    }

    const totalCallees = callSites.length + externalCallees.length;
    if (totalCallees === 0) {
      let hint = '';
      if (!includeExternal) {
        hint = '（该函数的所有被调用者均为外部符号，使用 include_external=true 查看）';
      }
      return this.textResult(`No callees found for "${symbol}"${allMatches.note}${hint}`);
    }

    const fileCache = new Map<string, string[]>();

    const shownResolved = callSites.slice(0, limit);
    const EXTERNAL_SUB_LIMIT = 10;
    const shownExternal = externalCallees.slice(0, EXTERNAL_SUB_LIMIT);
    const shownTotal = shownResolved.length + shownExternal.length;

    const lines: string[] = [
      `## Callees of "${symbol}" (${shownTotal} shown, ${totalCallees} total)`,
      '',
    ];
    for (const cs of shownResolved) {
      const defLine = cs.callee.startLine ? `:${cs.callee.startLine}` : '';
      const sourceNode = cg.getNode(cs.edge.source);
      const callSiteFile = sourceNode?.filePath ?? cs.callee.filePath;
      const callLine = cs.edge.line ?? cs.callee.startLine;
      const fileRef = `${callSiteFile}:${callLine}`;
      const snippet = this.sourceLineAt(cg, fileRef, fileCache);
      lines.push(`- **${cs.callee.name}** (${cs.callee.kind})`);
      lines.push(`  def: ${cs.callee.filePath}${defLine}`);
      lines.push(`  call: ${callSiteFile}:${callLine}${snippet ? ` — \`${snippet}\`` : ''}`);
      lines.push('');
    }
    for (const ext of shownExternal) {
      // Format method calls: capitalize receiver for readability
      // "commands.spawn" → "Commands::spawn", "下一个状态.set" → "下一个状态::set"
      let displayName = ext.name;
      const dotIdx = ext.name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = ext.name.slice(0, dotIdx);
        const method = ext.name.slice(dotIdx + 1);
        const capReceiver = receiver.charAt(0).toUpperCase() + receiver.slice(1);
        displayName = `${capReceiver}::${method}`;
      }
      lines.push(`- **${displayName}** (${ext.kind})`);
      if (displayName !== ext.name) {
        lines.push(`  via: \`${ext.name}\``);
      }
      lines.push(`  call: ${ext.filePath}:${ext.line}`);
      lines.push('');
    }

    if (totalCallees > shownTotal) {
      lines.push(`... and ${totalCallees - shownTotal} more callees`);
    }

    lines.push(allMatches.note);
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);
    const includeCode = args.includeCode === true;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate impact across all matching symbols
    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();

    for (const node of allMatches.nodes) {
      const impact = cg.getImpactRadius(node.id, depth);
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

    const formatted = this.formatImpact(symbol, mergedImpact, includeCode ? cg : null) + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_symbol_info — aggregated symbol information.
   * Returns definition, all incoming edge kinds (counted + top 5 details),
   * outgoing callees, and impact radius in a single call.
   */
  private async handleSymbolInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found`);
    }

    const lines: string[] = [`## Symbol Info: "${symbol}"`, ''];

    for (const node of allMatches.nodes) {
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(`- **定义**: ${node.filePath}:${node.startLine}`);
      if (node.signature) lines.push(`- **签名**: \`${node.signature}\``);

      // Incoming edges grouped by kind
      const incoming = cg.getIncomingEdges(node.id);
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

      // Outgoing callees (top 5)
      const callees = cg.getCallees(node.id);
      if (callees.length > 0) {
        lines.push(`- **被调用者** (${callees.length}):`);
        for (const c of callees.slice(0, 5)) {
          lines.push(`  - ${c.node.name} (${c.node.filePath}:${c.edge.line ?? c.node.startLine})`);
        }
        if (callees.length > 5) {
          lines.push(`  ... and ${callees.length - 5} more`);
        }
      }

      // Impact radius
      const impact = cg.getImpactRadius(node.id, 2);
      const rootSet = new Set(impact.roots);
      let l1 = 0, l2 = 0, l3 = 0;
      // Compute BFS distances from roots
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
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Format external callers from unresolved references (include_external=true, no project symbol).
   */
  private formatExternalCallers(
    unresolved: UnresolvedReference[], symbol: string, limit: number,
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
      return this.textResult(`No external callers found for "${symbol}"`);
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
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  private handleUsagesFromUnresolved(
    cg: CodeGraph, symbol: string, limit: number, kindFilter?: string,
  ): ToolResult | null {
    const unresolved = cg.getUnresolvedByName(symbol);
    if (unresolved.length === 0) {
      return null;
    }

    // Deduplicate by source node + kind + line
    const seen = new Set<string>();
    const usages: Array<{ sourceNode: Node; edgeKind: string; line: number }> = [];
    for (const ref of unresolved) {
      if (kindFilter && ref.referenceKind !== kindFilter) continue;
      const key = `${ref.fromNodeId}:${ref.referenceKind}:${ref.line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const sourceNode = cg.getNode(ref.fromNodeId);
      if (sourceNode) {
        usages.push({ sourceNode, edgeKind: ref.referenceKind, line: ref.line });
      }
    }

    if (usages.length === 0) {
      return null;
    }

    // Group by file
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

    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Handle codegraph_trace — shortest CALL PATH between two symbols.
   *
   * Exposes GraphTraverser.findPath: the chain of functions from `from` to `to`,
   * each hop annotated with file:line and the call-site line. This is the
   * capability grep/Read structurally cannot provide. When no static path
   * exists, the chain has almost certainly broken at dynamic dispatch
   * (callbacks, descriptors, metaclasses) — we say so and surface the start
   * symbol's outgoing calls so the agent bridges the one missing hop with
   * codegraph_node rather than blindly reading.
   */
  private async handleTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const from = this.validateString(args.from, 'from');
    if (typeof from !== 'string') return from;
    const to = this.validateString(args.to, 'to');
    if (typeof to !== 'string') return to;
    const includeCode = args.includeCode !== false;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const fromMatches = this.findAllSymbols(cg, from);
    if (fromMatches.nodes.length === 0) return this.textResult(`Symbol "${from}" not found in the codebase`);
    const toMatches = this.findAllSymbols(cg, to);
    if (toMatches.nodes.length === 0) return this.textResult(`Symbol "${to}" not found in the codebase`);

    // Trace along call edges only — a true call path. Names can map to several
    // nodes, so try a few from×to candidate pairs until a usable path turns up.
    //
    // MAX_HOPS guard: a BFS shortest path longer than this on a dense call graph
    // is almost always a spurious wander through unrelated code (django's
    // `_fetch_all → … → execute_sql` BFS detours through prefetch/filter), not
    // the real execution flow — and a confident-but-wrong 15-hop trace is worse
    // than none. Over-cap paths are rejected and reported as "no direct path"
    // (which, on real code, means the flow breaks at dynamic dispatch).
    const edgeKinds: Edge['kind'][] = ['calls'];
    const MAX_HOPS = 7;
    const fromTry = fromMatches.nodes.slice(0, 3);
    const toTry = toMatches.nodes.slice(0, 3);
    let path: Array<{ node: Node; edge: Edge | null }> | null = null;
    let overCap: Array<{ node: Node; edge: Edge | null }> | null = null;
    for (const f of fromTry) {
      for (const t of toTry) {
        const p = cg.findPath(f.id, t.id, edgeKinds);
        if (!p || p.length <= 1) continue;
        if (p.length <= MAX_HOPS) { path = p; break; }
        if (!overCap || p.length < overCap.length) overCap = p;
      }
      if (path) break;
    }

    if (!path) {
      // No static path — almost always a dynamic-dispatch break. Surface the
      // start symbol's outgoing calls so the agent can bridge the gap.
      const start = fromTry[0]!;
      const callees = cg.getCallees(start.id).slice(0, 10)
        .map(c => `${c.node.name} (${c.node.filePath}:${c.node.startLine})`);
      const lines = [
        `No direct call path from "${from}" to "${to}".`,
        '',
        (overCap
          ? `(Only a ${overCap.length}-hop indirect chain connects them — almost certainly a BFS wander through unrelated code, not the real flow.) `
          : '') +
        'The direct chain most likely breaks at **dynamic dispatch** (a callback, descriptor, ' +
        'metaclass, or attribute-as-callable) that static parsing cannot resolve into an edge. ' +
        `Inspect \`${start.name}\` (${start.filePath}:${start.startLine}) with codegraph_node ` +
        '(includeCode=true) — its body usually shows the dynamic call to follow next.',
      ];
      if (callees.length > 0) {
        lines.push('', `**${start.name} statically calls:** ${callees.join(', ')}`);
      }
      return this.textResult(lines.join('\n') + fromMatches.note + toMatches.note);
    }

    const lines: string[] = [
      `## Trace: ${from} → ${to}`,
      '',
      includeCode
        ? `Full execution path below — ${path.length} hops, each with its body, plus what the destination calls. This is the complete flow; answer from it.`
        : `Execution path — ${path.length} hops (source code omitted, set includeCode=true to include).`,
      '',
      `${path.length} hops:`,
      '',
    ];
    // Inline what each hop needs so the agent doesn't Read/Grep to get it: the
    // call-site source line, the registration site for dynamic-dispatch hops, AND
    // the hop's own body (capped per hop so the trace stays path-scoped). Earlier
    // versions inlined only the call-site line, which left agents calling explore
    // or Read for the bodies — the exact follow-up the ablation experiment measured.
    const fileCache = new Map<string, string[]>();
    for (let i = 0; i < path.length; i++) {
      const step = path[i]!;
      if (step.edge) {
        const synth = this.synthEdgeNote(step.edge);
        if (synth) {
          lines.push(`   ↓ ${synth.label}`);
          if (synth.registeredAt) {
            const regSrc = this.sourceLineAt(cg, synth.registeredAt, fileCache);
            lines.push(`     ↳ registered at ${synth.registeredAt}${regSrc ? `   ${regSrc}` : ''}`);
          }
        } else {
          // The call happens in the PREVIOUS hop's file at edge.line.
          const prev = path[i - 1];
          const ref = prev && step.edge.line ? `${prev.node.filePath}:${step.edge.line}` : undefined;
          const callSrc = this.sourceLineAt(cg, ref, fileCache);
          lines.push(`   ↓ ${step.edge.kind}${step.edge.line ? `@${step.edge.line}` : ''}${callSrc ? `   ${callSrc}` : ''}`);
        }
      }
      lines.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine}-${step.node.endLine})`);
      if (includeCode) {
        const body = this.sourceRangeAt(cg, step.node.filePath, step.node.startLine, step.node.endLine, fileCache, 60, 1800);
        if (body) lines.push(body);
      }
    }
    // The "last mile": what the destination does next. Agents otherwise explore/Read
    // for exactly this (e.g. renderStaticScene → _renderStaticScene → the canvas draw),
    // so inlining the destination's callees is what actually stops the investigation —
    // sufficiency, not a "don't explore" instruction.
    const dest = path[path.length - 1]!.node;
    const destCallees = cg.getCallees(dest.id)
      .filter(c => !path.some(p => p.node.id === c.node.id))
      .slice(0, 6);
    if (destCallees.length > 0) {
      lines.push('', `### \`${dest.name}\` then calls (the destination's immediate work):`);
      for (const c of destCallees) {
        lines.push('', `- ${c.node.name} (${c.node.filePath}:${c.node.startLine}-${c.node.endLine})`);
        if (includeCode) {
          const body = this.sourceRangeAt(cg, c.node.filePath, c.node.startLine, c.node.endLine, fileCache, 16, 600);
          if (body) lines.push(body);
        }
      }
    }
    lines.push('', includeCode
      ? '> Full path + every hop body + the destination\'s calls are inlined above — the complete flow. Answer from it; a Read is only needed to chase a specific local variable\'s data-flow.'
      : '> Path shown above. Set includeCode=true to inline source for each hop.');
    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Describe a synthesized (dynamic-dispatch) edge for human output: how the
   * callback was wired up — the bridge static parsing can't see. Returns null
   * for ordinary static edges. Used by trace + the node trail so a synthesized
   * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
   */
  private synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
    if (!edge || edge.provenance !== 'heuristic') return null;
    const m = edge.metadata as Record<string, unknown> | undefined;
    const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
    const at = registeredAt ? ` @${registeredAt}` : '';
    if (m?.synthesizedBy === 'callback') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
      const field = m.field ? ` on .${String(m.field)}` : '';
      return {
        label: `callback — registered via ${via}${field} (dynamic dispatch)`,
        compact: `dynamic: callback via ${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'event-emitter') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
      return {
        label: `event ${ev} — emit → handler (dynamic dispatch)`,
        compact: `dynamic: event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'react-render') {
      return {
        label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
        compact: `dynamic: React re-render via setState${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'jsx-render') {
      const child = m.via ? `<${String(m.via)}>` : 'a child component';
      return {
        label: `renders ${child} (JSX child — dynamic dispatch)`,
        compact: `dynamic: renders ${child}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'vue-handler') {
      const ev = m.event ? `@${String(m.event)}` : 'a template event';
      return {
        label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
        compact: `dynamic: Vue ${ev} handler`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'flutter-build') {
      return {
        label: `Flutter setState → build — setState re-runs build() (dynamic dispatch)`,
        compact: `dynamic: Flutter build via setState${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'cpp-override') {
      const via = m.via ? `::${String(m.via)}` : '';
      return {
        label: `C++ virtual override — base dispatches to subclass${via} (dynamic dispatch)`,
        compact: `dynamic: C++ virtual override${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'interface-impl') {
      return {
        label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
        compact: `dynamic: interface → impl${at}`,
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
    return null;
  }

  /**
   * Read one trimmed source line at "relpath:line" (relative to the project
   * root). `cache` holds split file contents so a multi-hop trace reads each
   * file at most once. Returns null if the file/line can't be resolved.
   */
  private sourceLineAt(cg: CodeGraph, ref: string | undefined, cache: Map<string, string[]>): string | null {
    if (!ref) return null;
    const i = ref.lastIndexOf(':');
    if (i < 0) return null;
    const filePath = ref.slice(0, i);
    const line = parseInt(ref.slice(i + 1), 10);
    if (!Number.isFinite(line) || line < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
      if (!abs || !existsSync(abs)) return null;
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, fileLines);
    }
    const raw = fileLines[line - 1];
    if (raw == null) return null;
    const t = raw.trim();
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
  }

  /**
   * Read a hop's body — filePath lines [startLine..endLine] — for inlining into
   * a trace, capped (lines + chars) so the whole path stays path-scoped even on
   * a 7-hop chain. Dedents to the body's own indentation and marks truncation.
   * Shares `cache` with sourceLineAt so each file is read at most once per trace.
   */
  private sourceRangeAt(
    cg: CodeGraph,
    filePath: string,
    startLine: number,
    endLine: number,
    cache: Map<string, string[]>,
    maxLines = 28,
    maxChars = 1200
  ): string | null {
    if (!Number.isFinite(startLine) || startLine < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
      if (!abs || !existsSync(abs)) return null;
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, fileLines);
    }
    const end = Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine;
    let slice = fileLines.slice(startLine - 1, end);
    if (slice.length === 0) return null;
    let omitted = 0;
    if (slice.length > maxLines) { omitted = slice.length - maxLines; slice = slice.slice(0, maxLines); }
    const nonBlank = slice.filter(l => l.trim().length > 0);
    const dedent = nonBlank.length ? Math.min(...nonBlank.map(l => l.length - l.trimStart().length)) : 0;
    let text = slice.map((l, i) => `      ${startLine + i}\t${l.slice(dedent)}`).join('\n');
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).replace(/\n[^\n]*$/, '');
      omitted = Math.max(omitted, 1);
    }
    if (omitted > 0) text += `\n      … (+${omitted} more line${omitted === 1 ? '' : 's'})`;
    return text;
  }

  /**
   * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
  private buildFlowFromNamedSymbols(cg: CodeGraph, query: string): string {
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor', 'enum', 'struct']);
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[\p{L}\p{N}_$][\p{L}\p{N}_$]*(?:(?:::|\.)[\p{L}\p{N}_$]+)*$/u.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return '';
      // Pool of name SEGMENTS (Class + method from every token) used to
      // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
      // CONTAINER class is itself named in the query.
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      for (const t of tokens) {
        const cands = this.findAllSymbols(cg, t).nodes.filter((n) => CALLABLE.has(n.kind));
        // A qualified or otherwise-specific name (<=3 hits) keeps all; an
        // ambiguous simple name keeps only candidates whose container is named.
        const pick = cands.length <= 3
          ? cands
          : cands.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        // If the disambiguation filter dropped everything, fall back to
        // the unfiltered candidates rather than silently losing the token.
        const chosen = pick.length > 0 ? pick : cands;
        for (const n of chosen.slice(0, 6)) named.set(n.id, n);
        if (named.size > 40) break;
      }
      if (named.size < 2) return '';
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // BFS the full call graph (incl. synth edges) from each named seed, but
      // only ACCEPT a sink that is also named — both ends anchored to symbols the
      // agent named, so the chain stays on-topic while bridging intermediates
      // (e.g. the exact interface overload) that the token resolution missed.
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      if (!best || best.length < 3) return '';
      const out = ['## Flow (call path among the symbols you queried)', ''];
      for (let i = 0; i < best.length; i++) {
        const step = best[i]!;
        if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
        out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
      }
      out.push('', '> Full source for these symbols is below; codegraph_trace(from,to) for the exact path between two endpoints.', '');
      return out.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const rawQuery = this.validateString(args.query, 'query');
    if (typeof rawQuery !== 'string') return rawQuery;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // P1: Inject path filter into query if provided.
    // Quote paths containing spaces so the query parser handles them as
    // a single token: path:"src/some dir/with spaces"
    const pathFilter = args.path as string | undefined;
    const needsQuoting = pathFilter && /\s/.test(pathFilter);
    const pathClause = needsQuoting ? `path:"${pathFilter}"` : `path:${pathFilter}`;
    const query = pathFilter ? `${pathClause} ${rawQuery}` : rawQuery;

    // P4: Skip relationship map when sourceOnly is true
    const sourceOnly = args.sourceOnly === true;

    // P1: Strict mode — limit results to files under the path directory
    const strict = args.strict === true;

    // Per-call gap accumulator — local so concurrent explore calls don't race.
    let exploreGaps: Map<string, { totalTopLevelSymbols: number; fullyShown: number; symbolsInGap: Array<{ name: string; lines: string; kind: string }> }> | undefined;

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('database is locked') || msg.includes('no such table')) {
        budget = getExploreOutputBudget(Infinity);
      } else {
        throw err;
      }
    }
    // P2: When sourceOnly is true, double the per-file and total output budget
    // since the relationship map (typically 20-30% of output) is skipped.
    // Also double the gap threshold so clusters merge more aggressively —
    // fewer, larger clusters use the budget more efficiently.
    if (sourceOnly) {
      budget = {
        ...budget,
        maxOutputChars: budget.maxOutputChars * 2,
        maxCharsPerFile: budget.maxCharsPerFile * 2,
        gapThreshold: budget.gapThreshold * 2,
      };
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
    }

    // Graph-aware glue: findRelevantContext builds the subgraph from name/text
    // search, so a method that BRIDGES named symbols — e.g. App.tsx's
    // triggerRender, which calls the named triggerUpdate — is never a search hit
    // and gets missed, forcing the agent to Read the file to trace it. Pull in
    // the callers/callees of the entry (root) nodes, but ONLY those that live in
    // files the subgraph already surfaces (where the agent reads to fill gaps),
    // so we add wiring without dragging in unrelated files. These get an
    // importance boost below so they survive the per-file cluster budget.
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set(subgraph.roots);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: entry point nodes worth 10, directly connected worth 3, others worth 1
      if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // Only include files that have entry points or nodes directly connected to entry points.
    // When a path filter is set, lower the threshold so all files in the directory
    // are eligible — the user asked for this directory explicitly, and maxFiles
    // should reflect the actual file count, not an opaque scoring cutoff.
    const minScore = pathFilter ? 1 : 3;
    const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= minScore);

    // When a path filter is set, backfill with all indexed files under that
    // directory so maxFiles honestly reflects the actual file count. Files
    // without query-matched symbols get score 0 and sort last.
    if (pathFilter) {
      const allFiles = cg.getFiles();
      const normalizedPath = pathFilter.replace(/\\/g, '/').replace(/\/$/, '') + '/';
      for (const f of allFiles) {
        const fp = f.path.replace(/\\/g, '/');
        if (fp.startsWith(normalizedPath) && !fileGroups.has(f.path)) {
          const entry: [string, { nodes: Node[]; score: number }] = [f.path, { nodes: [], score: 0 }];
          fileGroups.set(f.path, entry[1]);
          relevantFiles.push(entry);
        }
      }
    }

    // P1: Strict mode — when path is set and strict is true, remove files
    // and subgraph entries outside the path directory so results are scoped.
    if (strict && pathFilter) {
      const normalizedStrict = pathFilter.replace(/\\/g, '/').replace(/\/$/, '') + '/';
      for (let i = relevantFiles.length - 1; i >= 0; i--) {
        const fp = relevantFiles[i]![0].replace(/\\/g, '/');
        if (!fp.startsWith(normalizedStrict)) {
          fileGroups.delete(relevantFiles[i]![0]);
          relevantFiles.splice(i, 1);
        }
      }
      for (const [nodeId, node] of subgraph.nodes) {
        if (!node.filePath.replace(/\\/g, '/').startsWith(normalizedStrict)) {
          subgraph.nodes.delete(nodeId);
        }
      }
      subgraph.edges = subgraph.edges.filter(
        e => subgraph.nodes.has(e.source) && subgraph.nodes.has(e.target)
      );
    }

    // Extract query terms for relevance checking
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Sort files: highest relevance first, deprioritize low-value files
    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Check if any node name or file path relates to query terms
      const hasQueryRelevance = (filePath: string, nodes: Node[]) => {
        const fp = filePath.toLowerCase();
        if (queryTerms.some(t => fp.includes(t))) return true;
        return nodes.some(n => queryTerms.some(t => n.name.toLowerCase().includes(t)));
      };

      const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
      const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
      if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

      // Deprioritize test files, icon files, and i18n files
      const isLowValue = (p: string) =>
        /\/(tests?|__tests?__|spec)\//i.test(p) ||
        /\bicons?\b/i.test(p) ||
        /\bi18n\b/i.test(p);
      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      '',
    ];

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (!sourceOnly && budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
      lines.push('');

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    let anyFileTrimmed = false;

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      if (totalChars > budget.maxOutputChars * 0.9) break;

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // Whole-small-file rule: if a relevant file is small enough to afford,
      // return it ENTIRELY instead of clustering. Clustering exists to tame
      // god-files (App.tsx ~13k lines); on a ~134-line component a cluster is a
      // lossy subset of a file the agent will just Read in full anyway — costing
      // a round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      const WHOLE_FILE_MAX_LINES = 220;
      const WHOLE_FILE_MAX_CHARS = budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        const wholeHeader = `#### ${filePath} — ${omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')}`;

        if (totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          const remaining = budget.maxOutputChars - totalChars - 200;
          if (remaining < 500) break;
          wholeSection = wholeSection.slice(0, remaining) + '\n... (trimmed) ...';
          anyFileTrimmed = true;
        }
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        filesIncluded++;
        continue;
      }

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number }> = group.nodes
        .filter(n => n.startLine > 0 && n.endLine > 0)
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > budget.maxCharsPerFile) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      let fileSection = '';
      const allSymbols: string[] = [];
      let fileTrimmed = false;
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // If a single chosen cluster is still oversize (long monolithic
      // function), tail-trim it. Better one trimmed view than nothing.
      if (fileSection.length > budget.maxCharsPerFile) {
        fileSection = fileSection.slice(0, budget.maxCharsPerFile) + '\n... (trimmed) ...';
        fileTrimmed = true;
      }
      if (chosenIndices.size < clusters.length || fileTrimmed) {
        anyFileTrimmed = true;
        // Collect symbols in unchosen clusters for gap summary
        const gapSymbols: Array<{ name: string; lines: string; kind: string }> = [];
        for (let i = 0; i < clusters.length; i++) {
          if (!chosenIndices.has(i)) {
            for (const sym of clusters[i]!.symbols) {
              const parenIdx = sym.lastIndexOf('(');
              const name = parenIdx > 0 ? sym.substring(0, parenIdx) : sym;
              const kind = parenIdx > 0 ? sym.substring(parenIdx + 1, sym.length - 1) : 'unknown';
              gapSymbols.push({ name, lines: `${clusters[i]!.start}-${clusters[i]!.end}`, kind });
            }
          }
        }
        if (gapSymbols.length > 0) {
          if (!exploreGaps) exploreGaps = new Map();
          exploreGaps.set(filePath, {
            totalTopLevelSymbols: group.nodes.length,
            fullyShown: allSymbols.length,
            symbolsInGap: gapSymbols,
          });
        }
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = `#### ${filePath} — ${headerSuffix}`;

      // Respect the total output cap on a file-by-file basis.
      if (totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        const remaining = budget.maxOutputChars - totalChars - 200;
        if (remaining < 500) break;
        const trimmed = fileSection.slice(0, remaining) + '\n... (trimmed) ...';

        lines.push(fileHeader);
        lines.push('');
        lines.push('```' + lang);
        lines.push(trimmed);
        lines.push('```');
        lines.push('');
        totalChars += trimmed.length + 200;
        filesIncluded++;
        anyFileTrimmed = true;
        break;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
    }

    // Gap summary: tell the agent what symbols were omitted from truncated files
    if (exploreGaps && exploreGaps.size > 0) {
      lines.push('### Gap Summary');
      lines.push('');
      lines.push('The following symbols were omitted due to output budget limits. Use `codegraph_explore` with more specific query terms or increase `maxFiles` to include them.');
      lines.push('');
      for (const [file, gap] of exploreGaps) {
        lines.push(`**${file}** — ${gap.totalTopLevelSymbols} total symbols, ${gap.fullyShown} fully shown, ${gap.symbolsInGap.length} in gap:`);
        for (const sym of gap.symbolsInGap.slice(0, 15)) {
          lines.push(`  - ${sym.name} (${sym.kind}) @ lines ${sym.lines}`);
        }
        if (gap.symbolsInGap.length > 15) {
          lines.push(`  ... and ${gap.symbolsInGap.length - 15} more`);
        }
        lines.push('');
      }
    }

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('### Not shown above — explore these names for their source');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // Add completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. For a specific symbol you still need, run another \`codegraph_explore\` (or \`codegraph_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`);
    }

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Hard-cap to the adaptive budget. The per-file loop bounds the source
    // sections, but the relationship map, additional-files list, and
    // completeness/budget notes can still push the assembled output past
    // maxOutputChars (observed 30k against a 28k tier cap). A fat explore
    // payload persists in the agent's context and is re-read as cache-input
    // on every subsequent turn, so the overrun is paid many times over.
    const output = this.buildFlowFromNamedSymbols(cg, query) + lines.join('\n');
    if (output.length > budget.maxOutputChars) {
      const cut = output.slice(0, budget.maxOutputChars);
      const lastNewline = cut.lastIndexOf('\n');
      const safe = lastNewline > budget.maxOutputChars * 0.8 ? cut.slice(0, lastNewline) : cut;
      return this.textResult(safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)');
    }
    return this.textResult(output);
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const includeCode = args.includeCode === true;

    // Batch mode: symbols array — check BEFORE getCodeGraph (args check needs no DB)
    const symbolsArr = args.symbols as string[] | undefined;
    if (symbolsArr && Array.isArray(symbolsArr) && symbolsArr.length > 0) {
      const cg = this.getCodeGraph(args.projectPath as string | undefined);
      return this.handleBatchNode(cg, symbolsArr, includeCode);
    }

    if (args.symbols !== undefined && !Array.isArray(args.symbols)) {
      return this.errorResult('symbols must be an array of strings, e.g. symbols: ["X","Y","Z"]');
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);

    const match = this.findSymbol(cg, symbol);
    if (!match) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    let code: string | null = null;
    let outline: string | null = null;

    // O8: Always show member outline for container types (struct/enum/trait/interface)
    if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
      outline = this.buildContainerOutline(cg, match.node);
    }

    if (includeCode) {
      // For containers, outline suffices; for leaf symbols, fetch full source
      if (!outline) {
        code = await cg.getCode(match.node.id);
      }
    }

    const trail = this.formatTrail(cg, match.node);
    const schedule = this.formatSchedule(cg, match.node);
    const formatted = this.formatNodeDetails(match.node, code, outline) + schedule + trail + match.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle batch codegraph_node — multiple symbols in one call
   */
  private async handleBatchNode(cg: CodeGraph, symbols: string[], includeCode: boolean): Promise<ToolResult> {
    const batchLimit = Math.min(symbols.length, 20);
    const allLines: string[] = [`## Batch Node Details (${batchLimit} symbols)`, ''];

    for (const symbol of symbols.slice(0, batchLimit)) {
      const valid = this.validateString(symbol, 'symbols');
      if (typeof valid !== 'string') {
        allLines.push(`### \`${String(symbol).slice(0, 80)}\`: ${(valid as ToolResult).content[0]?.text ?? 'invalid'}`);
        allLines.push('');
        continue;
      }
      const match = this.findSymbol(cg, valid);
      if (!match) {
        allLines.push(`### ${valid}: not found`);
        allLines.push('');
        continue;
      }

      let code: string | null = null;
      let outline: string | null = null;
      if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
        outline = this.buildContainerOutline(cg, match.node);
      }
      if (includeCode) {
        if (!outline) {
          code = await cg.getCode(match.node.id);
        }
      }

      const trail = this.formatTrail(cg, match.node);
      const schedule = this.formatSchedule(cg, match.node);
      const formatted = this.formatNodeDetails(match.node, code, outline) + schedule + trail + match.note;
      allLines.push(formatted);
      allLines.push('');
    }

    allLines.push('---');
    allLines.push(`Total: ${batchLimit} symbols`);
    return this.textResult(this.truncateOutput(allLines.join('\n')));
  }

  /**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:line — so codegraph_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
  private formatTrail(cg: CodeGraph, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
      const synth = this.synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    if (callees.length === 0 && callers.length === 0) return '';
    const lines: string[] = ['', '### Trail — codegraph_node any of these to follow it (no Read needed)'];
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * O9: Show Bevy schedule registration info.
   * Queries runs_in edges to tell which schedule a system runs in.
   */
  private formatSchedule(cg: CodeGraph, node: Node): string {
    if (node.kind !== 'function' && node.kind !== 'method') return '';
    const runsInEdges = cg.getOutgoingEdges(node.id, ['runs_in']);
    if (runsInEdges.length === 0) return '';
    const lines: string[] = [];
    for (const edge of runsInEdges) {
      const schedNode = cg.getNode(edge.target);
      const schedName = schedNode?.name ?? 'unknown';
      const loc = edge.line ? `:${edge.line}` : '';
      const pluginMeta = (edge.metadata as Record<string, unknown> | undefined);
      const plugin = pluginMeta?.plugin as string | undefined;
      const by = plugin ? ` by ${plugin}` : '';
      lines.push(`- **Schedule:** ${schedName}${by}${loc ? ` (line ${edge.line})` : ''}`);
    }
    return lines.length > 0 ? `\n${lines.join('\n')}` : '';
  }

  /**
   * Handle codegraph_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const stats = cg.getStats();

    // Warn when this index actually belongs to a different git working tree
    // (e.g. the server resolved up from a nested worktree to the main checkout).
    // Queries then reflect that tree's branch, not the worktree being edited.
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '## CodeGraph Status',
      '',
    ];
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    // Surface the active SQLite backend (node:sqlite, Node's built-in real
    // SQLite — full WAL + FTS5, no native build).
    lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite supports WAL
    // everywhere, so a non-wal mode means the filesystem can't (network/
    // virtualized mounts, WSL2 /mnt). See issue #238.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Per-file freshness (issue #403). Only populated by the default's watcher.
    const pending = cg.getPendingFiles?.() ?? [];
    if (pending.length > 0) {
      lines.push('', '### Pending sync:');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle codegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `codegraph index` first.');
    }

    // Filter by path prefix
    let files = pathFilter
      ? allFiles.filter(f => f.path.startsWith(pathFilter) || f.path.startsWith('./' + pathFilter))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // P5: Fetch top-level symbols when requested
    const showSymbols = args.symbols === true;
    let symbolMap: Map<string, Array<{ name: string; kind: string }>> | undefined;
    if (showSymbols) {
      symbolMap = this.fetchTopLevelSymbols(cg, files);
    }

    // Format output
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    // Append symbols section if requested
    if (showSymbols && symbolMap && symbolMap.size > 0) {
      output += '\n\n' + this.formatFileSymbols(symbolMap, files.length);
    }

    return this.textResult(this.truncateOutput(output));
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
      .replace(/\*/g, '[^/]*')                // * matches anything except /
      .replace(/\?/g, '[^/]')                 // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /
    return new RegExp(escaped);
  }

  /**
   * Format files as a flat list
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`## Files (${files.length})`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format files grouped by language
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`### ${lang} (${langFiles.length})`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format files as a tree structure
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // Build tree structure
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // If this is the last part, it's a file
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // Render tree
    const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // Sort: directories first, then files, both alphabetically
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  /**
   * Fetch top-level symbols for a set of files in one bulk query.
   * Returns a map from file path to its top-level symbol list.
   */
  private fetchTopLevelSymbols(
    cg: CodeGraph,
    files: Array<{ path: string; language: string; nodeCount: number }>
  ): Map<string, Array<{ name: string; kind: string }>> {
    const symbolMap = new Map<string, Array<{ name: string; kind: string }>>();
    const fileSet = new Set(files.map(f => f.path));

    // Bulk query: get all top-level symbols. Use a high limit so large
    // repos don't have symbols truncated for files that sort late alphabetically.
    // Internal limit is 5× this value (searchAllByFilters multiplier).
    const results = cg.searchNodes('', {
      kinds: ['function', 'method', 'class', 'struct', 'enum', 'trait', 'interface', 'type_alias', 'module'] as NodeKind[],
      limit: Math.min(files.length * 10, 5000),
    });

    // Per-file cap: 10 for small projects, 5 for large (>1000 files)
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

  /**
   * Format the file symbols section for codegraph_files output.
   */
  private formatFileSymbols(
    symbolMap: Map<string, Array<{ name: string; kind: string }>>,
    totalFiles: number
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

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  /**
   * Check if a node matches a symbol query.
   *
   * Accepts simple names (`run`) and three flavors of qualifier:
   *   - dotted     `Session.request`         (TS/JS/Python)
   *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
   *   - slash      `configurator/stage_apply` (path-ish)
   *
   * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
   * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
   * the canonical `crate::module::symbol` form resolves.
   *
   * Resolution order, last part must always equal `node.name`:
   *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
   *      where the extractor builds the qualified name from the AST stack)
   *   2. File-path containment (handles file-derived modules in Rust/
   *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
   */
  private matchesSymbol(node: Node, symbol: string): boolean {
    // Simple name match
    if (node.name === symbol) return true;
    // File basename match (e.g., "product-card" matches "product-card.liquid")
    if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

    // Qualified-name lookups: split on any supported separator. `\w` keeps
    // identifier chars (incl. `_`) intact; everything else is treated as
    // a separator we tolerate.
    if (!/[.\/]|::/.test(symbol)) return false;
    const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
    if (parts.length < 2) return false;

    const lastPart = parts[parts.length - 1]!;
    if (node.name !== lastPart) return false;

    // Stage 1: qualified-name suffix match. The extractor joins the
    // semantic hierarchy with `::`, so `Session.request` and
    // `Session::request` both become `Session::request` here.
    const colonSuffix = parts.join('::');
    if (node.qualifiedName.includes(colonSuffix)) return true;

    // Stage 2: file-path containment. Rust modules and Python packages
    // are not in `qualifiedName` — they're encoded in the file path. So
    // `stage_apply::run` matches a `run` in any file whose path
    // contains a `stage_apply` segment (with or without an extension).
    //
    // Filter out Rust path prefixes that have no file-system equivalent.
    const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
    if (containerHints.length === 0) return false;

    const segments = node.filePath.split('/').filter((s) => s.length > 0);
    return containerHints.every((hint) =>
      segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
    );
  }

  private findSymbol(cg: CodeGraph, symbol: string): { node: Node; note: string } | null {
    // Use higher limit for qualified lookups (e.g., "Session.request",
    // "stage_apply::run") since the target may rank lower in FTS when
    // there are many partial matches across the qualifier parts.
    const isQualified = /[.\/]|::/.test(symbol);
    const limit = isQualified ? 50 : 10;
    let results = cg.searchNodes(symbol, { limit });

    // FTS strips colons as a special char, so `stage_apply::run` searches
    // for the literal `stage_applyrun` and finds nothing. Re-search by
    // the bare last part and let `matchesSymbol` filter by qualifier.
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0 || !results[0]) {
      return null;
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length === 1) {
      return { node: exactMatches[0]!.node, note: '' };
    }

    if (exactMatches.length > 1) {
      // Multiple exact matches - pick first, note the others
      const picked = exactMatches[0]!.node;
      const others = exactMatches.slice(1).map(r =>
        `${r.node.name} (${r.node.kind}) at ${r.node.filePath}:${r.node.startLine}`
      );
      const note = `\n\n> **Note:** ${exactMatches.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`. Others: ${others.join(', ')}`;
      return { node: picked, note };
    }

    // No exact match. For qualified lookups, don't silently fall back
    // to a fuzzy result — the user typed a specific qualifier, and
    // resolving `stage_apply::nonexistent_fn` to the unrelated
    // `stage_apply.rs` file would be actively misleading (#173).
    if (isQualified) return null;
    return { node: results[0]!.node, note: '' };
  }

  /**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
  private findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
    let results = cg.searchNodes(symbol, { limit: 50 });

    // Mirror the fallback in `findSymbol` for qualified queries — FTS
    // strips colons, so a module-qualified lookup needs a second pass
    // by the bare last part.
    if (results.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }

    if (results.length === 0) {
      return { nodes: [], note: '' };
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length <= 1) {
      const node = exactMatches[0]?.node ?? results[0]!.node;
      return { nodes: [node], note: '' };
    }

    // Multiple exact matches: rank by reference heat (incoming edge count)
    // to surface the most-used symbol first and enable auto-disambiguation
    // when one symbol dominates all others.
    const withHeat = exactMatches.map(r => ({
      node: r.node,
      heat: cg.getIncomingEdgeCount(r.node.id),
    }));
    withHeat.sort((a, b) => b.heat - a.heat);

    // When one symbol dominates (>3× the runner-up), note it as the likely
    // intended target but keep ALL matches in the node list. Aggregation tools
    // (callers, callees, impact, usages) need the full set to avoid silently
    // dropping edges from less-used symbols.
    let note = '';
    if (withHeat.length >= 2 && withHeat[0]!.heat > withHeat[1]!.heat * 3) {
      const top = withHeat[0]!.node;
      const others = withHeat.slice(1).map(r =>
        `${r.node.kind} at ${r.node.filePath}:${r.node.startLine} (${r.heat} refs)`
      );
      note = `\n\n> **Heads-up:** "${symbol}" matched ${exactMatches.length} symbols, ranked by reference heat. \`${top.name}\` (${withHeat[0]!.heat} incoming refs — ${withHeat[0]!.heat > 0 && withHeat[1]!.heat > 0 ? `${Math.round(withHeat[0]!.heat / withHeat[1]!.heat)}×` : 'dominates'} the next best) is almost certainly the intended target. Other matches: ${others.join(', ')}`;
    } else {
      const locations = withHeat.map(r =>
        `${r.node.kind} at ${r.node.filePath}:${r.node.startLine} (${r.heat} refs)`
      );
      note = `\n\n> **Note:** Aggregated results across ${exactMatches.length} symbols named "${symbol}", ranked by reference heat (most-referenced first): ${locations.join(', ')}`;
    }
    return { nodes: withHeat.map(r => r.node), note };
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  private formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatImpact(symbol: string, impact: Subgraph, codeSource: CodeGraph | null): string {
    const nodeCount = impact.nodes.size;

    // Compute BFS distance from root nodes to all affected nodes
    const rootSet = new Set(impact.roots);
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const rootId of impact.roots) {
      distance.set(rootId, 0);
      queue.push(rootId);
    }
    // Build reverse adjacency: target → sources (following incoming edges)
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

    // Overall risk breakdown (count symbols, not edges)
    let totalHigh = 0, totalMedium = 0, totalLow = 0;
    for (const [nodeId, kinds] of nodeIncomingKinds.entries()) {
      if (kinds.length === 0) continue;
      if (nodeId.startsWith('file:') || rootSet.has(nodeId)) continue;
      let hasHigh = false, hasMedium = false;
      for (const k of kinds) {
        const risk = this.classifyEdgeRisk(k);
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
      // Deduplicate file entries
      const files: Array<{ filePath: string; nodes: Node[] }> = [];
      for (const [filePath, fileNodes] of level.nodes) {
        // Drop whole-file envelope nodes when more specific symbols exist
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

      // Per-level risk breakdown (count symbols, not edges)
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
          const risk = this.classifyEdgeRisk(k);
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
          .filter(([k]) => this.classifyEdgeRisk(k as EdgeKind) === 'high')
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => `${c} ${k}`).join(', ');
        riskParts.push(`${lvlHigh} high-risk (${highKinds})`);
      }
      if (lvlMedium > 0) {
        const medKinds = [...lvlByKind.entries()]
          .filter(([k]) => this.classifyEdgeRisk(k as EdgeKind) === 'medium')
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
        // For Level 1 with includeCode, inline source snippets for each node
        if (isLevel1 && codeSource) {
          for (const n of nodes.slice(0, 10)) {
            const src = this.sourceRangeAt(codeSource, n.filePath, n.startLine, n.endLine, fileCache, 8, 400);
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
   * Classify an edge kind by risk level for impact analysis.
   *
   * When adding a new EdgeKind, add a case here so it isn't silently
   * treated as low risk.
   */
  private classifyEdgeRisk(kind: EdgeKind): 'high' | 'medium' | 'low' {
    switch (kind) {
      case 'calls':
      case 'extends':
      case 'implements':
      case 'overrides':
      case 'pattern_match':
      case 'on_enter':
      case 'on_exit':
        return 'high';
      case 'instantiates':
      case 'imports':
      case 'exports':
      case 'decorates':
      case 'runs_in':
      case 'registers_resource':
      case 'registers_message':
      case 'contains_plugin':
      case 'registers_system':
        return 'medium';
      case 'references':
      case 'type_of':
      case 'returns':
        return 'low';
      default:
        console.warn(`classifyEdgeRisk: unknown EdgeKind "${kind}" — treating as low risk`);
        return 'low';
    }
  }

  /**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
  private buildContainerOutline(cg: CodeGraph, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const MAX_MEMBERS = 50;
    const shown = children.slice(0, MAX_MEMBERS);
    const truncated = children.length > MAX_MEMBERS;

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of shown) {
      const loc = c.startLine ? `:${c.startLine}` : '';
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    if (truncated) {
      lines.push(`- ... and ${children.length - MAX_MEMBERS} more members`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `## ${node.name} (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call codegraph_node on a specific member for its body.`);
    } else if (code) {
      // Line-numbered (cat -n style, like codegraph_explore and Read) so the
      // agent can cite/edit exact lines without re-Reading the file for them.
      const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
      lines.push('', '```' + node.language, numbered, '```');
    }

    return lines.join('\n');
  }

  /**
   * Classify how a function references a type by inspecting its signature.
   * Returns 'mut' (mutable borrow, ResMut, &mut T), 'shared' (shared borrow,
   * Res, &T), 'owning' (owned value, return type, plain T), or 'unknown'.
   */
  private classifyMutability(signature: string | undefined | null, typeName: string): 'mut' | 'shared' | 'owning' | 'unknown' {
    if (!signature) return 'unknown';
    const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Unicode-aware word boundary: JS \b only matches ASCII [a-zA-Z0-9_],
    // so CJK type names (e.g. 导航上) never match. Use lookaround instead.
    const WB = `(?<![\\p{L}\\p{N}_])`;
    const WE = `(?![\\p{L}\\p{N}_])`;

    // Mutable: ResMut<Type>, &mut Type
    // Depth-aware: (?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)* handles up to 2 levels
    // of nested generics (e.g. ResMut<Query<Filter<Type>>>) instead of
    // stopping at the first > like [^>]* would.
    const NESTED = `(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*`;
    if (new RegExp(`ResMut\\s*<${NESTED}${WB}${escaped}${WE}`, 'u').test(signature)) return 'mut';
    if (new RegExp(`&mut\\s+${WB}${escaped}${WE}`, 'u').test(signature)) return 'mut';

    // Shared: Res<Type> (but not ResMut), &Type (but not &mut)
    if (new RegExp(`(?<!Mut)Res\\s*<${NESTED}${WB}${escaped}${WE}`, 'u').test(signature)) return 'shared';
    if (new RegExp(`(?<!&mut\\s)&${WB}${escaped}${WE}`, 'u').test(signature)) return 'shared';

    // Owned: return type (-> Type or -> impl ... Type ...), or plain param without &
    if (new RegExp(`->\\s*[^;{]*${WB}${escaped}${WE}`, 'u').test(signature)) return 'owning';
    if (new RegExp(`${WB}${escaped}${WE}`, 'u').test(signature)) return 'owning';

    return 'unknown';
  }

  private formatUsageResults(symbol: string, usages: Array<{ sourceNode: Node; targetNode: Node; edgeKind: string; line: number }>, limit: number): string {
    const byFile = new Map<string, typeof usages>();
    for (const u of usages) { const existing = byFile.get(u.sourceNode.filePath) || []; existing.push(u); byFile.set(u.sourceNode.filePath, existing); }
    const lines: string[] = [`### ${symbol} (${Math.min(usages.length, limit)} shown, ${usages.length} total)`, ""];
    let count = 0;
    for (const [file, fileUsages] of byFile) {
      if (count >= limit) break;
      lines.push(`**${file}:**`);
      for (const u of fileUsages) {
        if (count >= limit) break;
        const lineInfo = u.line ? `:${u.line}` : "";
        lines.push(`- ${u.sourceNode.name} (${u.sourceNode.kind}) ${u.edgeKind}→ ${u.targetNode.name}${lineInfo}`);
        count++;
      }
      lines.push("");
    }
    if (usages.length > limit) { lines.push(`... and ${usages.length - limit} more usages`); }
    return lines.join("\n");
  }

    private formatTaskContext(context: TaskContext): string {
    return context.summary || 'No context found';
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
