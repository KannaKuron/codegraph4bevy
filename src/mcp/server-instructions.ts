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

CodeGraph 是工作区中每个符号、边和文件的 SQLite 知识图谱。
读取亚毫秒级；索引通过文件监视器滞后写入约 1 秒。
在写代码或改代码**之前**咨询它，而非之后。

## 直接回答 — 不要委托探索

对于"X 怎么工作"、架构、trace 或定位类问题，直接用 2-3 次 codegraph 调用回答：
先 \`codegraph_context\`，再 ONE \`codegraph_explore\` 查看涉及符号的源码。
CodeGraph 是预建索引 — 委派给独立的文件读取子任务/agent，或自己跑 grep + read
循环，都是在重复 codegraph 已完成的工作且开销更大。仅在确认 codegraph 未覆盖的
具体细节时才用 Read/Grep。

## 按意图选择工具

- **"符号 X 是什么？"** → \`codegraph_search\`（\`referencesType\` 查引用某类型的所有符号，\`mutability\` 过滤借用模式；\`impl_for\` 查 trait/interface 的所有实现者；\`kind: "comment"\` 搜索注释；\`kind: "macro"\` 搜索宏调用位置；支持正则如 \`/handle.*Event\$/\`；\`offset\` 翻页，返回 \`total\` 总数）
- **"这个任务/功能/领域是怎么回事？"** → \`codegraph_context\`（主工具 — 一次调用组合 search + node + callers + callees）
- **"X 如何到达/变成 Y？/ 追踪 X 到 Y 的流程"** → \`codegraph_trace\`（一次调用返回完整调用路径，含动态调度跳转 — 回调、React re-render、JSX children、状态转换等 grep 无法跟踪的链路）
- **"谁调用了这个？"** → \`codegraph_callers\`（支持 \`symbols\` 数组批量查询；加 \`kind\` 参数查非调用关系：通用类型 \`"references"\`、\`"type_of"\`、\`"pattern_match"\`、\`"instantiates"\`、\`"all"\`；Bevy 特定类型用 \`bevy:\` 前缀：\`"bevy:runs_in"\`、\`"bevy:on_enter"\`、\`"bevy:on_exit"\`、\`"bevy:on_transition"\`、\`"bevy:registers_system"\`、\`"bevy:registers_resource"\`、\`"bevy:registers_message"\`、\`"bevy:registers_state"\`、\`"bevy:registers_observer"\`、\`"bevy:contains_plugin"\`、\`"bevy:configures_set"\`、\`"bevy:registers_type"\`、\`"bevy:registers_non_send"\`；\`include_external\` 显示项目外符号的引用）
- **"这个调用了什么？"** → \`codegraph_callees\`（\`include_external\` 显示对项目外符号的调用 — 第三方依赖、标准库宏等）
- **"分析一个符号的完整信息"** → \`codegraph_symbol_info\`（一次返回定义、所有入边种类计数、出向调用、影响半径 — 替代多次 callers kind=xxx 调用）
- **"改了这个会破坏什么？"** → \`codegraph_impact\`（支持 \`symbols\` 数组批量查询）
- **"显示这个符号的源码/签名/文档。"** → \`codegraph_node\`（支持 \`symbols\` 数组批量查询）
- **"查看多个相关符号的源码 / 概览一个区域。"** → \`codegraph_explore\`（单次有上限调用；优于多次 codegraph_node/Read 调用；\`path\` 过滤目录，\`strict\` 限定该目录，\`sourceOnly\` 跳过关系图；\`maxChars\` 覆盖输出上限，\`filesOffset\` 分页续传）
- **"目录 X 下有什么？"** → \`codegraph_files\`（\`symbols: true\` 包含顶层符号名）
- **"索引是否就绪 / 有多大？"** → \`codegraph_status\`

## 常用链路

- **流程 / "X 如何到达 Y"**：FIRST \`codegraph_trace\` from→to — 一次调用返回完整路径含动态调度跳转。如需查看跳转体再 ONE \`codegraph_explore\`。不要用 \`codegraph_search\` + \`codegraph_callers\` 重建路径 — trace 一次完成。
- **上手项目**：先 \`codegraph_context\`。不够清晰再用 \`codegraph_explore\` 扩展，然后 \`codegraph_node\` 深入具体符号。
- **重构规划**：\`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`。影响范围答案来自 impact，不是手动遍历 callers。
- **调试回归**：对可疑符号 \`codegraph_callers\`；如有意外调用再 \`codegraph_impact\` 扩大范围。

## 反模式

- **不要先 grep 再查符号名** — \`codegraph_search\` 更快，一次返回 kind + 位置 + 签名。支持正则/后缀匹配，无需退回 grep。
- **不要 \`codegraph_search\` + \`codegraph_node\` 链式调用** — \`codegraph_context\` 一次往返就够了。
- **不要对多个符号循环调 \`codegraph_node\`** — 一次 \`codegraph_explore\` 按文件分组返回全部，每次单独调用重读整个上下文，开销大得多。单个符号用 \`codegraph_node\`。\`codegraph_impact\`、\`codegraph_callers\`、\`codegraph_node\` 也支持 \`symbols\` 数组批量。
- **不要在编辑文件后立即查询索引** — 监视器需要约 500ms 去抖 + 同步。等下一轮。
- **搜索结果分页** — \`codegraph_search\` 用 \`offset\` 翻页，不要换查询词重搜。

## 局限性

- 索引滞后文件写入约 1 秒。
- 跨文件解析是尽力而为的名称匹配；模糊调用可能返回多个候选。
- 不做实时正确性验证 — 那仍是 TypeScript 编译器/测试套件/linter 的工作。Codegraph 提供它们没有的结构化上下文作为补充。
`;
