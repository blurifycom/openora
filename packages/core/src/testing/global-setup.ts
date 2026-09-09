import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { adminDatabaseUrl, testDatabasePrefix } from './real-infra.js';

/**
 * Remove the databases `createTestDb` created for this run, once the run is over.
 *
 * `DROP DATABASE` forces a cluster-wide immediate checkpoint, so dropping one per test
 * file makes 80-odd of them queue behind each other while the workers are still running
 * - long enough, measured on a local cluster with `fsync` on, to stall an unrelated
 * file's teardown past its hook timeout. Sweeping here moves all of it after the last
 * test.
 *
 * The sweep is confined to the run id set below, so a second run sharing this Postgres
 * server keeps its own databases. The cost is that a run killed outright leaves its
 * databases behind, which `pnpm db:clean:test` clears.
 */
export default async function setup(): Promise<() => Promise<void>> {
  process.env['OPENORA_TEST_RUN_ID'] = randomUUID().replaceAll('-', '').slice(0, 8);
  const prefix = testDatabasePrefix();
  const admin = new Pool({ connectionString: adminDatabaseUrl(), connectionTimeoutMillis: 5000 });

  return async () => {
    try {
      const { rows } = await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [`${prefix.replaceAll('_', '\\_')}%`],
      );
      for (const { datname } of rows) {
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  };
}
