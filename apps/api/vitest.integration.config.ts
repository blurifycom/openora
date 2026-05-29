import { defineConfig } from 'vitest/config';

// Integration tests boot the real Hono + oRPC app against a real Postgres test
// database and exercise it via `app.request()`. All suites share one database,
// so they must run single-threaded. Requires `pnpm build` first (loadExtensions
// resolves compiled dist plugins) and a reachable TEST_DATABASE_URL.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // All suites share one Postgres test DB, so they must not run concurrently.
    fileParallelism: false,
    // better-auth needs a secret (token/2FA crypto) and a base URL (to build
    // password-reset / verification links). CI sets these; default them locally
    // so the suite is self-contained.
    env: {
      BETTER_AUTH_SECRET:
        process.env['BETTER_AUTH_SECRET'] ?? 'test-secret-not-for-production-0000000000',
      BETTER_AUTH_URL: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3001',
    },
  },
});
