import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.int.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    // 60s, not the usual 30: a teardown sweep of the per-suite databases forces one
    // cluster-wide checkpoint per drop, and on a local cluster with `fsync` on the first
    // of those was measured at 55s. Every backend waits it out, including a hook in the
    // other integration tier still running its tail. CI turns `fsync` off, so there the
    // ceiling is never approached.
    hookTimeout: 60_000,
    // This tier partitions Redis by `VITEST_POOL_ID % 8` (real-infra.ts), leaving 8-15
    // to `@openora/testing` so both integration suites can run concurrently. More than
    // 8 workers would wrap that modulo and let two workers flush each other's keys.
    maxWorkers: 8,
  },
});
