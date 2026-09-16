import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The tests themselves, and the adapter contract suite, which is a test harness shipped to
      // consumers rather than library code. Every adapter runs it in `adapters.contract.test.ts`.
      exclude: ['src/__tests__/**', 'src/testing/**'],
      reporter: ['text', 'lcov'],
      // The suite covers every line, branch and function. A drop means a new path arrived with no
      // test, or a branch became unreachable and should be deleted rather than left behind.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
