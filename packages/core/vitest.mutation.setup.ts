import { Client } from 'pg';
import { vi } from 'vitest';
import { ADMIN_DATABASE_URL } from './src/testing/admin-database-url';

const WAIT_FOR_TIMEOUT_MS = 15_000;
const waitFor = vi.waitFor;

vi.waitFor = (callback, options) =>
  waitFor(
    callback,
    typeof options === 'number' ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options },
  );

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
