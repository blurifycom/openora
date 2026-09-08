import { Pool } from 'pg';
import { adminDatabaseUrl, TEST_DATABASE_PREFIX } from './real-infra.js';

/**
 * Remove every database `createTestDb` created, once per run.
 *
 * `DROP DATABASE` forces a cluster-wide immediate checkpoint, so dropping one per test
 * file makes 80-odd of them queue behind each other while the workers are still running
 * - long enough, measured on a local cluster with `fsync` on, to stall an unrelated
 * file's teardown past its 30s hook timeout. Sweeping here moves all of it after the
 * last test, and covers whatever a killed run left behind on the way in.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = new Pool({ connectionString: adminDatabaseUrl(), connectionTimeoutMillis: 5000 });

  await dropTestDatabases(admin);

  return async () => {
    await dropTestDatabases(admin);
    await admin.end();
  };
}

async function dropTestDatabases(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${TEST_DATABASE_PREFIX}%`],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}
