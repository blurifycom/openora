import { defineConfig } from 'vitest/config';

// Every suite here boots the real app (bootTestApp) against a real Postgres test db,
// so all suites share one database and cannot run in parallel (see AGENTS.md).
// Requires `pnpm build` on @openora/core first (loadExtensions() resolves compiled
// dist/**/plugin.js).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
