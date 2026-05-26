# CLAUDE.md

CodeGraph 的个人 fork，面向 **Rust + Bevy ECS** 代码库的深度代码理解工具。

## 项目概述

CodeGraph 是一个本地优先的代码智能库 + CLI + MCP 服务器。通过 tree-sitter 解析代码，将符号/边/文件存储在 SQLite（FTS5）中，以知识图谱的形式通过 MCP 暴露给 AI agent。每个项目的数据存储在 `.codegraph/` 中。提取是确定性的——从 AST 派生，而非 LLM 总结。

以 `@colbymchenry/codegraph` 发布在 npm 上；同一个二进制文件既是安装器，也是索引器和 MCP 服务器。

## 构建、测试、运行

```bash
npm run build           # tsc + 复制 schema.sql 和 *.wasm 到 dist/；给 dist/bin/codegraph.js 添加执行权限
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run（全部）
npm run test:watch
npm run test:eval       # 仅 __tests__/evaluation/
npm run eval            # 构建后通过 tsx 运行 __tests__/evaluation/runner.ts

npm run cli             # 构建后运行本地 dist 二进制文件

# 单个测试文件 / 匹配模式
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets`（从 `build` 调用）将 `src/db/schema.sql` 和所有 `src/extraction/wasm/*.wasm` 文件复制到 `dist/`。**任何新的 SQL 或语法 wasm 必须被复制，否则不会随包发布。**

Node 引擎要求：`>=20.0.0 <25.0.0`。Node <20 和 Node 25.x 会直接退出（见 `src/bin/node-version-check.ts`）。

## 架构

### 分层流水线

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

公共 API 入口是 `src/index.ts`——`CodeGraph` 类连接所有层并重新导出类型。库用户只接触这个文件；MCP 服务器和 CLI 也通过它驱动。

### 模块布局

- `src/index.ts` — `CodeGraph` 类：`init`/`open`/`close`、`indexAll`、`sync`、`searchNodes`、`findImplementors`、`getCallers`/`getCallees`、`getImpactRadius`、`buildContext`、`watch`/`unwatch`
- `src/db/` — `DatabaseConnection`、`QueryBuilder`（预编译语句）、`schema.sql`。后端优先使用 `better-sqlite3`（原生），不可用时透明回退到 `node-sqlite3-wasm`。`codegraph status` 会显示当前使用的后端；wasm 是慢路径。
- `src/extraction/` — `ExtractionOrchestrator`、tree-sitter 封装、`languages/` 下每种语言一个提取器文件，以及非 tree-sitter 格式的独立提取器（`svelte-extractor.ts`、`vue-extractor.ts`、`liquid-extractor.ts`、`dfm-extractor.ts` 用于 Delphi）。`parse-worker.ts` 将繁重的解析工作放到 worker 线程。
- `src/resolution/` — `ReferenceResolver` 协调 `import-resolver.ts`（含 `path-aliases.ts` 用于 tsconfig path 别名 + cargo workspace member glob）、`name-matcher.ts` 和 `frameworks/`（Express、Laravel、Rails、FastAPI、Django、Flask、Spring、Gin、Axum、ASP.NET、Vapor、React Router、SvelteKit、Vue/Nuxt、Cargo workspaces、Bevy）。框架解析器生成 `route` 节点、`references` 边和 `callback` 合成边。
- `src/graph/` — `GraphTraverser`（BFS/DFS、影响半径、路径查找）和 `GraphQueryManager`（高级查询）。
- `src/context/` — `ContextBuilder` + 用于 markdown/JSON 输出的格式化器。
- `src/search/` — FTS5 的全文查询解析器和辅助工具。
- `src/sync/` — `FileWatcher`（原生 FSEvents/inotify/RDCW），带去抖 + 过滤，以及 git hook 辅助工具。
- `src/mcp/` — MCP 服务器（`MCPServer`、`tools.ts`、`transport.ts`）。`server-instructions.ts` 是服务器在 MCP `initialize` 响应中返回的内容——与面向用户的工具指南保持同步。
- `src/installer/` — 多 agent 安装器入口，支持 Claude Code、Cursor、Codex CLI、OpenCode。
- `src/bin/codegraph.ts` — CLI（commander）。子命令：`install`、`init`、`uninit`、`index`、`sync`、`status`、`query`、`files`、`context`、`affected`、`serve --mcp`
- `src/ui/` — 终端 UI（shimmer 进度条、worker）

### NodeKind / EdgeKind

定义在 `src/types.ts` 中。提取器和解析器都必须使用这些确切的字符串。

- **NodeKind**: `file`、`module`、`class`、`struct`、`interface`、`trait`、`protocol`、`function`、`method`、`property`、`field`、`variable`、`constant`、`enum`、`enum_member`、`type_alias`、`namespace`、`parameter`、`import`、`export`、`route`、`component`
- **EdgeKind**: `contains`、`calls`、`imports`、`exports`、`extends`、`implements`、`references`、`type_of`、`returns`、`instantiates`、`overrides`、`decorates`、`pattern_match`

---

## Fork 定位：Rust/Bevy 特化 CodeGraph

这个 fork **不是**通用代码智能工具，而是专为 **Rust + Bevy ECS** 代码库优化。所有修改服务于以下目标：

- **Bevy DSL 语义提取** — 将 `app.add_systems()`、`app.init_resource()`、`PluginGroup::build()`、状态转换（`NextState`、`ComputedStates`、`SubStates`）识别为一等图边
- **Rust 语义深度** — match/if-let 模式引用、宏调用提取、枚举变体类型引用、turbofish 泛型——这些都是 grep 无法恢复的结构化信息
- **CJK 搜索质量** — jieba 分词用于 FTS，CJK 感知的名称匹配和查询解析

上游 CodeGraph 追求广度（多语言、多 agent target、最小维护面）。本 fork 追求深度（单一语言生态、最大结构覆盖）。两者互补，非竞争。

### 合并哲学：采纳架构，重建功能

上游每次变更，按变更本身的价值来评估，而非"保护我们的 diff"：

1. **架构改进无条件欢迎。** 守护进程、watcher、sync、默认忽略目录——这些在工程上都是更优解。全量采纳，在新基础上重建我们的功能。

2. **功能删除不自动拒绝。** 如果上游删了我们用的东西，先问：*在新架构上能否实现相同甚至更好的效果？* 有时上游的简化反而揭示了更干净的路径。例如：上游把 MCP 服务器拆成 daemon/engine/session 三层，我们的 Bevy 工具作为 engine 插件集成可能比之前内联在单体服务器里更好。

3. **不做兼容性修补。** 不保留旧 API、不重新导出已删除的类型、不添加 `_compat` 包装器来维持现有代码能跑。如果上游重写了 `tools.ts`，我们就按新的模式重写 Bevy 工具处理器。兼容性补丁腐烂得快，且让未来的合并更难。

4. **不确定时先讨论再动手。** 如果上游的变更有意思但会破坏我们的功能，先讨论权衡。"上游新的 X 更干净——我们应该在新的基础上重做 Bevy Y，还是有理由认为我们的方案对 Rust 来说根本性更好？"

### 评估上游变更：检查清单

对每个上游 commit 或变更的文件：

1. **上游为什么改这个？**（理解他们的动机）
2. **这个问题在我们的 fork 里存在吗？**（如果有，我们需要这个修复）
3. **这个变更与我们的 Bevy/CJK 功能有结构性冲突吗？**（没有就自由采纳）
4. **如果有冲突，能在新基础上把我们的功能做得更好吗？**（核心问题——不要假设我们的旧方案就是最好的）
5. **上游的方案对我们的用例来说确实更好吗？**（例如：守护进程架构意味着一个项目一个 CodeGraph 实例——我们的 Bevy 工具同样受益于跨 MCP 客户端共享状态）

### 已知分歧点（保持更新）

这些是本 fork 与上游有意的分歧区域。合并时重点关注这些文件：

| 层 | 文件 | 我们的增加 | 上游方向 |
|---|------|-----------|---------|
| 提取 | `src/extraction/tree-sitter.ts`、`languages/rust.ts` | Bevy DSL 模式、Rust match/if-let/macro 引用提取、语言感知的 forward-decl guard（仅对非 Rust 语言跳过无 body struct/enum） | 删除所有语言特定语义提取、无差别 forward-decl guard |
| 提取流程 | `src/extraction/index.ts` | `extractAndStoreComments()` + `associateCommentWithSymbol()` 注释关联、`extractFile` 和 sync 路径中 4 处 hook 调用 | 删除注释提取（无 comments 表） |
| 解析 | `src/resolution/callback-synthesizer.ts`、`frameworks/rust.ts`、`index.ts`、`name-matcher.ts` | Bevy ECS 边合成（N11/N12）、保留 `RUST_STD_MACROS`、`crate::` 前缀处理 | 删除所有框架特定合成、简化引用删除 |
| MCP 工具 | `src/mcp/tools.ts`、`server-instructions.ts` | `codegraph_callers` kind 参数扩展、批处理模式、`include_external`、`referencesType`/`impl_for` 参数、Bevy 合成边标签、worktree 不匹配检测 | 简化 API 表面积、删除批处理 |
| 搜索 | `src/search/jieba-helper.ts`、`query-utils.ts` | jieba CJK 分词、`escapeLike`、`isDependencyFile`、Unicode 感知的 token 拆分 | 删除 CJK 支持、仅 ASCII token 化 |
| 数据库 | `src/db/schema.sql`、`migrations.ts`、`queries.ts` | `comments` 表、`fts_tokens` 列、`findImplementors()`、`findNodesByReferencedType()`、`searchComments()` | 删除 comments 表、删除实现者查询、schema 版本回退 |
| 上下文 | `src/context/index.ts`、`formatter.ts` | Bevy ECS state/resource 标签、CJK 查询分词、`EntryPointUsage` 统计 | 删除框架特定标签、CJK 处理、入口点统计 |
| 核心 API | `src/index.ts`、`src/types.ts` | `findImplementors()`、`findNodesByReferencedType()`、`searchComments()`、`EntryPointUsage`、`pattern_match` EdgeKind | 从公共 API 中删除 |
| 测试 | `__tests__/extraction*.ts`（3 文件） | **保持三个文件拆分**以避免 V8 Zone OOM（Node 24/Windows） | 合并为单个 `extraction.test.ts` |
| 配置 | `.claude/settings.json` | 项目级 Claude Code 权限配置 | 删除 |

---

## 从上游同步 — 逐个检查，禁止直接合并

**绝对不能 `git merge upstream/main` 直接合入工作分支。** 上游可能做了大重构，直接合并会导致冲突爆炸或静默覆盖个人修改。必须逐个 commit/文件检查后手动挑选。

### 第一步：同步本地 main 到上游

```bash
git fetch upstream
git branch -f main upstream/main    # 不切换分支，强制对齐本地 main
git push origin main                # 推到 fork 的 remote main
```

### 第二步：审查上游变更

```bash
# 查看上游有哪些新 commit
git log HEAD..upstream/main --oneline

# 查看上游改了哪些文件，哪些与自己有重叠
git diff HEAD..upstream/main --stat
```

### 第三步：逐个文件/commit 检查后手动合并

对每个上游变更的文件，先判断它的性质，再决定处理方式：

**纯新增文件**（上游新增、自己没改过）：
```bash
git checkout upstream/main -- <file>
```

**上游重写的文件**（架构重构）：不要想"怎么保留 diff"，而要想"我们的功能在新架构上怎么实现"。完全接受上游版本，然后在新结构上重新接入 Bevy 功能。
```bash
git checkout upstream/main -- <file>
# 然后在新架构上重新实现我们的功能
```

**上游删掉的文件**：确认文件被删的原因。如果不影响我们的功能，跟随删除。如果是我们的功能文件（如 `jieba-helper.ts`），保留。

**有重叠的文件**（两边都改了）：先读上游 diff，理解其重构意图。不自动"保留我们的版本"，而是判断上游的改法是否更好。如果是，在新代码上重做我们的功能。
```bash
# 查看某个文件的上游 diff
git diff HEAD..upstream/main -- <file>

# 拿取无冲突的单个文件
git checkout upstream/main -- <file>

# 有冲突的文件：Read 双方版本后手工 Edit
```

### 第四步：验证

```bash
npm run build && npx vitest run
```

---

## 分支关系

| 分支 | 说明 |
|------|------|
| `main` | 跟踪 `upstream/main`——仅用于拉取上游变更，然后合并到工作分支 |
| `个人改造适配分支不pr给原项目` | **主工作分支**——所有开发在此进行 |
| `buk-备份-个人改造适配分支不pr给原项目` | **备份分支**——备份的合并目标 |

### 远程仓库

| Remote | URL | 用途 |
|--------|-----|------|
| `origin` | `github.com/KannaKuron/codegraph4bevy` | 个人 fork — **可推送** |
| `fork` | `github.com/KannaKuron/codegraph4bevy` | 个人 fork — **可推送**（与 origin 相同） |
| `upstream` | `github.com/colbymchenry/codegraph` | 上游 — 仅 fetch，**永不推送** |

### Git 工作流规则

- **"合并"始终指合并到 `buk-备份-个人改造适配分支不pr给原项目` 进行备份**，而非合并到 `main`
- **"推送"指 `git push origin` 或 `git push fork`**（两者相同，都推到个人 fork）
- **`main` 只接受上游变更**：`git fetch upstream` → 合并到工作分支
- 合并时的关键冲突区域：`src/mcp/tools.ts`、`src/extraction/tree-sitter.ts`、`src/resolution/callback-synthesizer.ts`

## 提交与备份

```bash
# 在工作分支上提交，然后备份到 buk
git checkout "个人改造适配分支不pr给原项目"
# ... 修改、提交 ...
git checkout "buk-备份-个人改造适配分支不pr给原项目" && git merge "个人改造适配分支不pr给原项目"
git checkout "个人改造适配分支不pr给原项目"
git push origin "个人改造适配分支不pr给原项目" "buk-备份-个人改造适配分支不pr给原项目"
```

备份后：`npm run build && npx vitest run` 验证。

## 全局部署

全局使用的 `codegraph` 始终从当前工作分支构建，而非 npm 发布的版本。

```bash
# 一次性设置
npm run build && npm link

# 之后只需重新构建即可更新
npm run build
```

- `npm link` 只需运行一次；后续 `npm run build` 就地更新 `dist/`
- MCP 配置指向全局链接的二进制文件

## 开发规则

- **每次完成任务后必须 `npm run build && npm link`**，确保全局 `codegraph` 二进制指向最新构建。全局部署通过 `npm link` 完成，后续只需 `npm run build` 即可更新
- **编译后必须 `npm test` 跑测试**，确认无回归
- **编译+MCP 代码变更后必须提醒用户重启**：`build` 只更新 `dist/` 中的代码，已运行的 MCP 服务器不自动重载。提示用户重启 MCP 服务器（或在 Claude Code 中 reconnect）使新代码生效。如果不提醒，用户测试时 `codegraph_*` MCP 工具仍使用旧代码
- 修改 MCP 工具行为或 agent 使用方式时，需同步更新 `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts` 和 `.cursor/rules/codegraph.mdc`——它们写在不同位置但内容相同
- CodeGraph 提供**代码上下文**，而非产品需求。新功能需要用户确认 UX、边界条件和验收标准——图谱不会告诉你这些
- **正则表达式必须匹配类型/函数/方法名，绝不能用变量名。** 编写检测 API 使用模式的正则时，匹配不变的部分——类型路径（`NextState::Pending`）、函数名（`in_state`）或方法调用（`.add_systems(` 带前导点）。绝不要硬编码变量名如 `next_state`、`commands`、`app` 或 `router`——这些是开发者自由命名的标识符；CJK 名称、缩写或任何有效标识符都会让模式静默失效。对接收者/变量槽使用通用标识符类（`[\p{L}\p{N}_]+`、`\w+`）

## 动态调度覆盖 — 流必须在图中端到端存在

静态 tree-sitter 提取会遗漏计算/间接调用，因此流在动态调度处断裂，agent 被迫 Read 来重建。合成器/解析器桥接这些断裂点，使 `trace`/`explore` 端到端连接（`src/resolution/callback-synthesizer.ts`、`src/resolution/frameworks/`）。当前渠道：callback/observer、EventEmitter、React re-render（`setState`→`render`）、JSX child（`render`→子组件）、django ORM descriptor、**Bevy ECS state transitions**（`NextState::Pending` producer → `in_state` consumer、ComputedStates/SubStates 传递）。所有合成边均为 `provenance:'heuristic'`，带有 `metadata.synthesizedBy` + `registeredAt`（注册点），在 `trace`、节点追踪和上下文调用路径中内联显示。

**原则：部分覆盖比无覆盖更糟。** 桥接一个边界但不桥接下一个，会揭示一个跳跃点，agent 随之钻取 + Read 来完成。验证于 excalidraw：只有 react-render 反而使 Read 上升到 5-7；只有完成整个流（添加 jsx-child 跳跃）才降到 0-1。**始终端到端关闭流并重新测量**——绝不要交付半桥接的流。

### 每个新语言/框架的验证方法

对每个 **语言 × 框架**，在**小型、中型和大型**真实仓库上用 **≥3 个不同的流提示**验证：

1. 选择框架的标准流（"X 如何到达 Y"：state→render、request→handler→view、query→SQL、action→reducer→store…）
2. **确定性探针**（`scripts/agent-eval/probe-{trace,node,context,explore}.mjs` 针对构建后的 `dist/`）：`trace(from,to)` 端到端连接无断裂；**无节点爆炸**（`select count(*) from nodes` 在重新索引前后稳定）；合成边**精度**抽查（`select … where provenance='heuristic'`）
3. **Agent A/B**（`scripts/agent-eval/run-all.sh <repo> "<Q>"`）：有 vs 无 codegraph，**≥2 轮/组**（运行间方差大——绝不要从 n=1 得出结论）。记录**耗时、总工具调用、Read、Grep**
4. **通过标准：** 正常流问题在仓库的 explore 调用预算内达到 **~0 Read/Grep**，运行**快于**无 codegraph，且**在对照仓库上无回归**。将数据记录在 `docs/design/dynamic-dispatch-coverage-playbook.md`（覆盖矩阵）中

### Excalidraw 验证示例（TS/React，中型仓库，643 文件）

这是每个语言/框架需要复制的模板。问题：*"更新元素如何重新渲染屏幕上的画布？"*（完整流跨越三个 React 边界：observer callback、`setState`→`render` 和 JSX child）。

| 阶段 | 耗时 | Read | Grep | codegraph |
|------|------|------|------|-----------|
| 无 codegraph | 115–139s | 9–10 | 10–11 | 0 |
| Broken（explore-budget 回归） | 131–139s | 5–10 | 3–5 | 6–14 |
| 修复后（budget + msgs + synthesis） | 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first 引导 | **51–74s** | **0–2** | 0–4 | **3–4** |

n=4 无 hook 运行/阶段，相同提示。引导流问题优先使用 `codegraph_trace` 后：**最佳运行 0 Read / 0 Grep / 3 codegraph / 51s**；**4 轮中 2 轮完全干净**。引导消除了过度钻取方差——调用次数从 3–10 收紧到 3–4，trace 采用率从 3/4 上升到 4/4。运行间方差仍然存在；始终报告范围，绝不报告单次运行。

### Explore 预算 — 保持两项预算随仓库大小单调递增

`src/mcp/tools.ts` 中有两个函数根据索引文件数缩放 explore。这是预期的解决方案（此处的回归会静默迫使 agent 回到 Read）：

| 仓库 | 文件数 | explore 调用次数 | 字符数/调用 | 每文件字符数 |
|------|--------|-----------------|------------|-------------|
| express（小） | 147 | 1 | 18K | 3800 |
| excalidraw/django（中） | 643–3043 | 2 | 28K | 6500 |
| vscode（大） | 10446 | 3 | 35K | 7000 |
| ~20k / ~40k | — | 4 / 5 | 38K | 7000 |

- `getExploreBudget(fileCount)` → **调用**预算：`<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5`（最多 5）
- `getExploreOutputBudget(fileCount)` → **每次调用**输出（字符数 / 文件数 / 每文件字符数）
- **不变量：较大层级绝不能比较小层级获得更小的 `maxCharsPerFile`。**（导致此文档的回归：`<5000` 层级的 2500 *低于* `<500` 层级的 3800，因此在 god-file 仓库——excalidraw 的 415 KB `App.tsx`——一次 explore 返回不到文件 1% 的内容，强制回退到 Read）
- Explore 输出**绝不能告诉 agent "使用 Read"**——引导到另一次 `codegraph_explore`，并"将返回的源代码视为已 Read"

### 适应工具而非改变 agent

决定检索改进能否落地的杠杆。**在构建任何东西之前先测试这一点：这次改动是否让 agent _已经在调用_的工具，用 agent _已经给出的_输入做更多事？如果需要 agent 改变行为——选择不同工具、改变查询方式、从例子学习——就会撞上低显著性墙，无法落地。**

CodeGraph 影响 agent 的唯一渠道是低显著性的：MCP `initialize` 指令（`server-instructions.ts`）和工具描述。改变它们**不能**可靠地改变 agent 的工具_选择_或查询风格——已验证：将 trace-first 引导移植到 server-instructions + 工具描述（3 个措辞变体）从未复现 CLI `--append-system-prompt` 的效果，且相比基线**退化**了 wall-clock 时间。新工具表现更差（很少被选择——agent 连 `trace` 都少选）；"更好的例子"是同样的引导问题。

有效的是在 agent 已经在的地方与它相遇：
- **充分性** — `codegraph_trace` 内联每个跳跃点的主体 + 目的地自身的被调用者，因此一次 trace 调用结束流调查（无需后续 explore/node/Read）
- **explore-flow** — `codegraph_explore` 的查询是一个精确的符号名包（含限定名如 `Class.method`），覆盖 agent 要追踪的流；explore 在_这些命名符号中_找到调用路径（利用合成边），并在输出开头展示——通过 agent 确实会发起的调用，提供 trace 质量的流

失败的是反向操作——将精确答案折叠到**模糊输入**工具中。`codegraph_context` 接收描述而非符号，因此无法消歧流的端点，并显示_错误的功能_。精确输出需要精确输入。

此轴下剩余的杠杆是**覆盖率**：每个使流静态连接的改进（新的动态调度合成器）都会自动被 explore-flow/`trace` 暴露，无需 agent 改变。反应式/协调器运行时（Halo 的 `ReactiveExtensionClient`、MediatR、Vue Proxy）是前沿——这些地方的流没有静态边，因此没有东西暴露（正确——沉默比错误好）。

## 开发经验

以下是用 bug 和回归换来的教训，在本 fork 中也应遵守。

### MCP 服务器指令同步

`src/mcp/server-instructions.ts` 是每个 agent 收到的**第一样东西**，关于如何使用工具。修改 MCP 工具行为或 agent 使用方式时，需**同时更新以下三个文件**（它们写在不同位置但表达相同内容）：
1. `src/mcp/server-instructions.ts` — MCP initialize 响应
2. `src/installer/instructions-template.ts` — agent 无关的指令文件
3. `.cursor/rules/codegraph.mdc` — Cursor IDE 规则文件

### 测试文件拆分与 V8 Zone OOM — **绝不合并**

提取测试**必须保持三个独立文件**，因为加载约 20 个 tree-sitter WASM 语法并在单进程中运行 250+ 次解析操作会耗尽 V8 Zone 内存（JIT 编译器内部结构，非 JS 堆），在某些平台上（特别是 Node 24 / Windows）。vitest 配置使用 `pool: 'forks'` 使每个文件在自己的进程中运行。

| 文件 | 内容 |
|------|------|
| `__tests__/extraction.test.ts` | 核心提取测试 + Rust 特定测试（turbofish、宏调用、pattern_match） |
| `__tests__/extraction-extended.test.ts` | 扩展提取测试（多语言边缘情况） |
| `__tests__/extraction-import.test.ts` | 导入解析测试 |

**上游已将这三个文件合并为一个 `extraction.test.ts`——每次合并时必须拒绝此变更，保持拆分。** 合并为一个文件后，Node 24 上 Zone OOM 会导致测试无法跑完（约 195/255 通过后 worker 崩溃）。

### 绝对不能删除的文件

以下文件是本 fork 的核心资产，上游删了但我们必须保留。**合并时绝不能删除：**

| 文件 | 保留原因 |
|------|---------|
| `src/search/jieba-helper.ts` | CJK 分词核心，query-utils/query-parser 依赖 |
| `src/extraction/comment-extractor.ts` | 基于正则的注释提取，extraction/index.ts 调用 |
| `__tests__/comment-association.test.ts` | 注释关联测试覆盖 |
| `__tests__/comment-extractor.test.ts` | 注释提取器测试覆盖 |
| `__tests__/n10-nested-call.test.ts` | 嵌套调用提取（unresolved_refs）测试 |
| `__tests__/search-query-parser.test.ts` | 含 CJK jieba 分词排名测试 |
| `__tests__/frameworks-integration.test.ts` | **含 121 行 Bevy 测试引用**，必须保留 |
| `__tests__/extraction-extended.test.ts` | 必须与 extraction.test.ts 分开以避免 Zone OOM |
| `__tests__/extraction-import.test.ts` | 必须与 extraction.test.ts 分开以避免 Zone OOM |
| `.claude/settings.json` | 项目级 Claude Code 权限配置 |

### Windows 验证（Parallels + SSH）

任何 Windows 特定的 PR、bug 或实现，在真实 Windows VM 上验证而非猜测。连接信息存储在仓库根目录的 gitignored **`.parallels`** 文件中（VM 名称、客户机 IP、SSH 用户/密钥）。`prlctl exec` 需要 Parallels Pro 且不可用，因此 SSH 是桥梁。

- 从 Mac 主机连接/运行：`ssh <user>@<guest_ip> "..."`。多行工作通过 stdin 管道传输 PowerShell，并**先从注册表刷新 PATH**（sshd 的会话在 winget 安装后 PATH 过期）：
  ```
  ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  Set-Location C:\dev\codegraph
  PS
  ```
- 在 **Windows 本地**路径（`C:\dev\codegraph`）全新 clone 并 `npm ci`——绝不在共享的 Mac 仓库上运行 npm，因为 `esbuild`/`rollup` 携带平台特定二进制
- 客户机工具链（winget）：Node LTS、Git 和 **VC++ ARM64 可再发行组件**（`@rollup/rollup-win32-arm64-msvc` 需要，vitest 会拉取）
- 从贡献者 fork 直接获取 PR head 以避免 `pull/<n>/head` 延迟：`git fetch <fork-url> <branch>` 然后 `git checkout -f FETCH_HEAD`
- 已知的预先存在的 Windows 失败：`security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink`（符号链接创建在 Windows 上需要权限）；以及 `mcp-initialize.test.ts` / `mcp-roots.test.ts` 套件，在 `afterEach` 中以 `EPERM` 失败删除临时目录，因为生成的 `serve --mcp`（其 `--liftoff-only` re-exec 孙子进程）仍持有 cwd / SQLite 文件——Windows 文件锁定特性，非逻辑 bug。这些失败与当前工作无关；不要让它们掩盖新的回归

### 跨平台测试门控

行为因平台而异（路径解析、驱动器号、`SENSITIVE_PATHS`、`%APPDATA%` 配置目录、CRLF）必须门控，不能假设。对仅 Windows 的断言使用 `it.runIf(process.platform === 'win32')(...)`，对仅 POSIX 的使用 `it.runIf(process.platform !== 'win32')(...)`——例如 `/etc` 在 POSIX 上是敏感路径，但在 Windows 上解析为 `C:\etc`（不存在），因此未门控的 `/etc` 断言在 Windows 上会失败。在合并之前在实际 Windows 上验证 Windows 门控测试；不要合并未见过运行的 Windows 门控测试。
