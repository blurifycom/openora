import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.int.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // This tier partitions Redis by `VITEST_POOL_ID % 8` (real-infra.ts), leaving 8-15
    // to `@openora/testing` so both integration suites can run concurrently. More than
    // 8 workers would wrap that modulo and let two workers flush each other's keys.
    maxWorkers: 8,
  },
});
