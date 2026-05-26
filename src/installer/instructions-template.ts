/**
 * Agent-instructions template — the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / codegraph.mdc / etc.).
 *
 * The body content is identical across agents because the codegraph
 * usage advice is agent-agnostic — only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 */
export const INSTRUCTIONS_TEMPLATE = `${CODEGRAPH_SECTION_START}
## CodeGraph

本项目配置了 CodeGraph MCP 服务器（\`codegraph_*\` 工具）。CodeGraph 是基于 tree-sitter 的代码知识图谱，存储每个符号、边和文件的结构化信息。查询亚毫秒级，返回 grep 无法获取的结构关系。

### 何时用 codegraph 而非原生搜索

codegraph 用于**结构化**问题 — 谁调用了谁、改这个会影响什么、X 在哪里定义、X 的签名是什么。原生 grep/read 仅用于**文本字面**查询（字符串内容、注释、日志消息），或已打开具体文件之后。

| 问题 | 工具 |
|---|---|
| "X 在哪里定义？" / "查找符号 X" | \`codegraph_search\`（\`referencesType\` 查引用某类型的所有符号，\`mutability\` 过滤借用模式；\`impl_for\` 查 trait/interface 的所有实现者；\`kind: "comment"\` 搜索注释） |
| "谁调用了 Y？" | \`codegraph_callers\`（支持 \`symbols\` 数组批量查询；加 \`kind\` 参数查非调用关系：\`"references"\`、\`"type_of"\`、\`"pattern_match"\`、\`"instantiates"\` 及框架特定边） |
| "Y 调用了什么？" | \`codegraph_callees\`（\`include_external\` 显示对外部/第三方 API 的调用） |
| "X 如何到达/变成 Y？" | \`codegraph_trace\`（一次调用返回完整路径，含动态调度跳转 — 回调、React re-render、状态转换等 grep 无法跟踪的链路） |
| "改了 Z 会破坏什么？" | \`codegraph_impact\`（\`includeCode\` 内联受影响符号的源码） |
| "显示 Y 的签名/源码/文档" | \`codegraph_node\`（支持 \`symbols\` 数组批量查询） |
| "给我某个任务/领域的聚焦上下文" | \`codegraph_context\` |
| "一次查看多个相关符号的源码" | \`codegraph_explore\`（\`path\` 过滤目录，\`strict\` 限定该目录，\`sourceOnly\` 跳过关系图） |
| "搜索注释" | \`codegraph_search\` 加 \`kind: "comment"\` |
| "某目录下有什么文件" | \`codegraph_files\`（\`symbols: true\` 包含顶层符号名） |
| "索引是否正常" | \`codegraph_status\` |

### 使用原则

- **直接回答，不要委托探索。** "X 怎么工作" / 架构问题：先 \`codegraph_context\`，再 ONE \`codegraph_explore\` 查看涉及符号的源码。具体**流程**（"X 如何到达 Y"）：先 \`codegraph_trace\` from→to — 一次调用返回完整路径含动态跳转 — 再 ONE \`codegraph_explore\` 查看跳转体。不要用 \`codegraph_search\` + \`codegraph_callers\` 手动重建路径 — 那正是 trace 一次完成的事。CodeGraph 是预建索引，启动子任务/agent 或用 grep + read 循环是重复已完成的工作且开销更大。
- **信任 codegraph 结果。** 来自完整 AST 解析。不要用 grep 重新验证 — 更慢、更不准、浪费上下文。
- **查符号名时不要先用 grep。** \`codegraph_search\` 更快，一次返回 kind + 位置 + 签名。
- **不要 \`codegraph_search\` + \`codegraph_node\` 链式调用** — 一个 \`codegraph_context\` 就够。
- **不要对多个符号循环调 \`codegraph_node\`** — 一次 \`codegraph_explore\` 返回多个符号的源码，分组在单次有上限的调用中；每个单独的 node/Read 调用都会重读整个上下文，开销大得多。
- **explore 返回原始源码** — 与 Read 字节一致，带行号。explore 展示过的文件视为已 Read，不要重复打开。
- **索引延迟**：文件监视器写入后约 500ms 去抖；同一轮内编辑文件后不要立即重新查询。

### 常用链路

- **流程 / "X 如何到达 Y"**：FIRST \`codegraph_trace\` from→to — 一次调用返回完整路径含动态调度跳转（回调、React re-render、框架状态转换、Django ORM 描述符）。如需查看跳转体再 ONE \`codegraph_explore\`。不要用 \`codegraph_search\` + \`codegraph_callers\` 重建路径 — trace 一次完成。
- **上手项目**：先 \`codegraph_context\`。不够清晰再用 \`codegraph_explore\` 扩展，然后 \`codegraph_node\` 深入具体符号。
- **重构规划**：\`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`。影响范围的答案来自 impact，不是手动遍历 callers。
- **调试回归**：对可疑符号 \`codegraph_callers\`；如有意外调用再 \`codegraph_impact\` 扩大范围。

### 如果 \`.codegraph/\` 不存在

MCP 服务器返回 "not initialized"。询问用户：*"本项目尚未初始化 CodeGraph，要我运行 \`codegraph init -i\` 构建索引吗？"*
${CODEGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
