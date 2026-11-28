import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { adminDatabaseUrl, testDatabasePrefix } from './real-infra.js';

export default async function setup(): Promise<() => Promise<void>> {
  process.env['OPENORA_TEST_RUN_ID'] ??= randomUUID().replaceAll('-', '').slice(0, 8);
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
