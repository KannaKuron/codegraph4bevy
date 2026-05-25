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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
