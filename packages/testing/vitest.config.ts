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
    // 60s, not the usual 30: a teardown sweep of the per-suite databases forces one
    // cluster-wide checkpoint per drop, and on a local cluster with `fsync` on the first
    // of those was measured at 55s. Every backend waits it out, including a hook in the
    // other integration tier still running its tail. CI turns `fsync` off, so there the
    // ceiling is never approached.
    hookTimeout: 60_000,
  },
});
