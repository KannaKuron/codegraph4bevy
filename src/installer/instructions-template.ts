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

本项目配置了 CodeGraph MCP 服务器（\`codegraph_*\` 工具）。工具选择和常用链路见 MCP Server Instructions。

### 使用原则

- **直接回答，不要委托探索。** 架构问题：先 \`codegraph_context\`，再 ONE \`codegraph_explore\`。流程问题：先 \`codegraph_trace\` from→to，再 ONE \`codegraph_explore\`。不要用 \`codegraph_search\` + \`codegraph_callers\` 手动重建路径。
- **信任 codegraph 结果。** 来自完整 AST 解析。不要用 grep 重新验证。
- **查符号名时不要先用 grep。** \`codegraph_search\` 更快，一次返回 kind + 位置 + 签名。
- **不要 \`codegraph_search\` + \`codegraph_node\` 链式调用** — 一个 \`codegraph_context\` 就够。
- **不要对多个符号循环调 \`codegraph_node\`** — 一次 \`codegraph_explore\` 返回多个符号的源码。
- **explore 返回原始源码** — 与 Read 字节一致，带行号。explore 展示过的文件视为已 Read，不要重复打开。
- **索引延迟**：文件监视器写入后约 500ms 去抖；同一轮内编辑文件后不要立即重新查询。

### 如果 \`.codegraph/\` 不存在

MCP 服务器返回 "not initialized"。询问用户：*"本项目尚未初始化 CodeGraph，要我运行 \`codegraph init -i\` 构建索引吗？"*
${CODEGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
