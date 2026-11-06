import { Client } from 'pg';
import { vi } from 'vitest';
import { ADMIN_DATABASE_URL } from './src/testing/admin-database-url';

// Instrumented code on a busy runner misses `vi.waitFor`'s default 1s, and one such miss in
// Stryker's initial run aborts the whole run.
const WAIT_FOR_TIMEOUT_MS = 15_000;
const waitFor = vi.waitFor;

vi.waitFor = (callback, options) =>
  waitFor(
    callback,
    typeof options === 'number' ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options },
  );

// The tiers sweep their databases in global teardown, but Stryker keeps one vitest alive for the
// whole run, so every mutant's test files would pile up clones until Postgres runs out of disk.
// This runs before each test file. Stryker pins vitest to one worker and files do not share a
// process, so whatever this run has left belongs to a file that has finished. The e2e tier's
// template stays: only its clones carry the trailing `_`.
const runId = process.env['OPENORA_TEST_RUN_ID'] ?? '';
const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
await admin.connect();
const { rows } = await admin.query<{ datname: string }>(
  `SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2`,
  [`test\\_${runId}\\_%`, `oss\\_igaming\\_test\\_tpl\\_${runId}\\_%`],
);
for (const { datname } of rows) {
  await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
}
await admin.end();
