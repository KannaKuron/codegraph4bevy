/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# CodeGraph — 基于索引知识图谱的代码智能工具

CodeGraph 是预建代码知识图谱（SQLite）。索引通过文件监视器滞后写入约 1 秒。
在写代码或改代码**之前**咨询它，而非之后。

## 原则
- 结构化查询用 CG，不用 grep/Read 重复 CG 已建索引的工作
- 信任 CG 结果（来自 AST 解析），不要用 grep 重新验证
- 批量查询优先：\`symbols\` 数组、\`codegraph_explore\` 多符号，优于逐个 \`codegraph_node\`
- \`codegraph_explore\` 返回原始源码（与 Read 一致），展示过的文件视为已 Read
- \`codegraph_search\` 用 \`offset\` 翻页，不要换查询词重搜
- 索引延迟 ~500ms，编辑后不立即重查

## 工具速查
| 意图 | 首选工具 |
|------|---------|
| 符号搜索 | \`codegraph_search\` |
| 任务/功能理解 | \`codegraph_context\`（Bevy UI 任务自动输出组件树） |
| 调用追踪（X→Y） | \`codegraph_trace\` |
| 调用者/用法查询 | \`codegraph_callers\` |
| 被调用者查询 | \`codegraph_callees\` |
| 影响分析 | \`codegraph_impact\` |
| 符号详情 | \`codegraph_node\` |
| 批量源码 | \`codegraph_explore\` |
| 聚合符号信息 | \`codegraph_symbol_info\` |
| 项目结构 | \`codegraph_files\` |
| 索引状态 | \`codegraph_status\`

## codegraph_callers kind 参数参考
不指定时只返回 callers（calls 边）。指定后返回该类型的所有用法（含 incoming 和 outgoing）：
- 通用：\`references\`、\`type_of\`、\`pattern_match\`、\`instantiates\`、\`contains\`、\`all\`
  注：\`all\` 仅返回该符号已有入边的种类，不含未产生边的框架关系
- Bevy 前缀：\`bevy:registers_system\`、\`bevy:registers_resource\`、\`bevy:registers_observer\`、\`bevy:registers_state\`、\`bevy:registers_message\`、\`bevy:registers_type\`、\`bevy:registers_non_send\`、\`bevy:runs_in\`、\`bevy:on_enter\`、\`bevy:on_exit\`、\`bevy:on_transition\`、\`bevy:contains_plugin\`、\`bevy:configures_set\`

## codegraph_search 特殊 kind
\`comment\`（注释搜索）、\`macro\`（宏调用位置）、\`method_call\`（方法调用点）。\`referencesType\` 查引用某类型的所有符号；\`impl_for\` 查 trait/interface 的所有实现者；\`mutability\` 过滤借用模式（mut/shared/owning）。
`;
