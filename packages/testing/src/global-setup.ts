import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { applyMigrations, templateDatabase, adminUrl, urlForDatabase } from './db.js';

/**
 * Build the template database every suite in this tier clones from, once per run, and
 * sweep this run's clones afterwards.
 *
 * Migrating once and cloning is what makes a database per suite affordable: the clone is
 * a ~50ms `CREATE DATABASE ... TEMPLATE`, against ~250ms of migration checks per suite
 * plus the truncate they would otherwise need to stay out of each other's rows.
 *
 * Clones are dropped here rather than by each suite: only 2 of the 19 suites dispose
 * their database, and a sweep covers the ones that do not. The sweep is confined to the
 * run id set below - one that matched the whole prefix would drop the databases of a
 * second run sharing this Postgres server, out from under its live connections.
 */
export default async function setup(): Promise<() => Promise<void>> {
  process.env['OPENORA_TEST_RUN_ID'] = randomUUID().replaceAll('-', '').slice(0, 8);
  const template = templateDatabase();
  const admin = new Pool({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });

  try {
    await admin.query(`CREATE DATABASE "${template}"`);
    await applyMigrations(urlForDatabase(template));
  } catch (err) {
    await dropRunDatabases(admin, template).catch(() => {});
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
