// No imports on purpose: `vitest.mutation.setup.ts` needs this before each test file, and pulling
// in core there would load modules ahead of that file's `vi.mock` calls.
export const ADMIN_DATABASE_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5434/postgres';
