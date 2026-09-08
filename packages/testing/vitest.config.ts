import { defineConfig } from 'vitest/config';

// Every suite here boots the real app (bootTestApp) against a real Postgres database of
// its own, cloned from the template `global-setup.ts` migrates once per run.
// Requires `pnpm build` on @openora/core first (loadExtensions() resolves compiled
// dist/**/plugin.js).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./src/global-setup.ts'],
    // Two, not more: this tier owns 8 of Redis's 16 logical databases and a single suite
    // can keep three booted apps alive at once, so a worker needs a slice of 4 (see
    // src/redis.ts). More workers than slices and two suites flush each other's keys.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
