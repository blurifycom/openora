import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**', 'src/**/*.int.{test,spec}.ts'],
    // Re-importing the core barrels once per test file dominates this tier's runtime,
    // and nothing here touches real infra, so files can share a worker's module graph.
    // Stays on `forks` (the default) rather than `threads`: platform-config-loader's
    // tests call `process.chdir`, which throws inside a worker thread.
    isolate: false,
  },
});
