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

This project has a CodeGraph MCP server (\`codegraph_*\` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | \`codegraph_search\` (use \`referencesType\` to find symbols referencing a type, with \`mutability\` to filter by borrowing mode; use \`impl_for\` to find implementors of a trait/interface; use \`kind: "comment"\` to search comments) |
| "What calls function Y?" | \`codegraph_callers\` (supports batch via \`symbols\` array) |
| "What does Y call?" | \`codegraph_callees\` (use \`include_external\` to show calls to external/third-party APIs) |
| "How does X reach/become Y? / trace the flow from X to Y" | \`codegraph_trace\` (one call = the whole path, incl. dynamic-dispatch hops — callbacks, React re-render, Bevy state transitions — that grep can't follow) |
| "Where is this symbol used (any kind)?" | \`codegraph_usages\` (broader than callers — covers refs, type annotations, instantiations, pattern matches; supports batch via \`symbols\` array; use \`kind: "pattern_match"\` for match/if-let sites) |
| "What would break if I changed Z?" | \`codegraph_impact\` (use \`includeCode\` to inline source snippets of directly affected symbols) |
| "Show me Y's signature / source / docstring" | \`codegraph_node\` (supports batch via \`symbols\` array) |
| "Give me focused context for a task/area" | \`codegraph_context\` |
| "See several related symbols' source at once" | \`codegraph_explore\` (use \`path\` to filter by directory, \`strict\` to limit results to that directory, \`sourceOnly\` to skip the relationship map) |
| "Search comments" | \`codegraph_search\` with \`kind: "comment"\` |
| "What files exist under path/" | \`codegraph_files\` (use \`symbols: true\` to include top-level symbol names) |
| "Is the index healthy?" | \`codegraph_status\` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture questions, answer with 2-3 codegraph calls: \`codegraph_context\` first, then ONE \`codegraph_explore\` for the source of the symbols it surfaces. For a specific **flow** ("how does X reach Y") start with \`codegraph_trace\` from→to — one call returns the whole path with dynamic hops bridged — then ONE \`codegraph_explore\` for the bodies; don't rebuild the path with \`codegraph_search\` + \`codegraph_callers\`. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. \`codegraph_search\` is faster and returns kind + location + signature in one call.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one call.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Explore returns verbatim source** — byte-for-byte identical to Read, line-numbered. Treat files shown by explore as already Read; don't re-open them.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### Common chains

- **Flow / "how does X reach Y"**: \`codegraph_trace\` from→to FIRST — one call returns the entire path with dynamic-dispatch hops bridged (callbacks, React re-render, Bevy state transitions, Django ORM descriptors). Then ONE \`codegraph_explore\` for the hop bodies if needed. Do NOT reconstruct the path with \`codegraph_search\` + \`codegraph_callers\` — that's exactly what trace does in a single call.
- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

### If \`.codegraph/\` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run \`codegraph init -i\` to build the index?"*
${CODEGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
