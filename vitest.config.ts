import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Use child-process forks so each test file gets its own V8 isolate.
    // The extraction tests load ~20 tree-sitter WASM grammars and run 250+
    // parse operations; in thread mode the cumulative V8 Zone memory (JIT
    // compiler internals, not the JS heap) exceeds the per-isolate limit on
    // some platforms (notably Node 24 / Windows).  Forks give each file a
    // fresh Zone.  maxForks: 1 serialises files to avoid concurrent WASM
    // heaps compounding the peak RSS.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        minForks: 1,
      },
    },
    /**
     * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
     * mcp-roots) spawn `dist/bin/codegraph.js serve --mcp` with `process.execPath`
     * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
     * the CLI's hard-block (src/bin/codegraph.ts) would otherwise exit the child
     * before it ever responds, so every spawn-based test times out — see #478.
     *
     * Setting the override here keeps the CLI's runtime guard intact for end
     * users (it's still enforced when `codegraph` is invoked directly) while
     * letting the test suite run on whatever Node the contributor happens to
     * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
     * there, so the variable is a no-op.
     */
    env: { CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
