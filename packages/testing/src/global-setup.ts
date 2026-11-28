import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Pool } from 'pg';
import { applyMigrations, templateDatabase, adminUrl, urlForDatabase } from './db.js';
import { TRACE_RESULTS_DIR } from './trace-recorder.js';

export default async function setup(): Promise<() => Promise<void>> {
  rmSync(TRACE_RESULTS_DIR, { recursive: true, force: true });
  process.env['OPENORA_TEST_RUN_ID'] ??= randomUUID().replaceAll('-', '').slice(0, 8);
  const template = templateDatabase();
  const admin = new Pool({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });

  try {
    await admin.query(`CREATE DATABASE "${template}"`);
    await applyMigrations(urlForDatabase(template));
  } catch (err) {
    await dropRunDatabases(admin, template).catch((cleanupErr: unknown) => {
      console.error(`failed to drop test databases for template "${template}"`, cleanupErr);
    });
    await admin.end();
    throw err;
  }

  return async () => {
    try {
      await dropRunDatabases(admin, template);
    } finally {
      await admin.end();
    }
  };
}

async function dropRunDatabases(admin: Pool, template: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2`,
    [template, `${template}\\_%`],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}
