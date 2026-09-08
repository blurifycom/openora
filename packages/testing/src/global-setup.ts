import { Pool } from 'pg';
import { applyMigrations, TEMPLATE_DATABASE, adminUrl, urlForDatabase } from './db.js';

/**
 * Build the template database every suite in this tier clones from, once per run, and
 * sweep the clones afterwards.
 *
 * Migrating once and cloning is what makes a database per suite affordable: the clone is
 * a ~50ms `CREATE DATABASE ... TEMPLATE`, against ~250ms of migration checks per suite
 * plus the truncate they would otherwise need to stay out of each other's rows.
 *
 * Clones are dropped here rather than by each suite: only 2 of the 19 suites dispose
 * their database, and a sweep by prefix covers the ones that do not, plus anything a
 * killed run left behind.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = new Pool({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });

  await dropClones(admin);
  await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  await applyMigrations(urlForDatabase(TEMPLATE_DATABASE));

  return async () => {
    await dropClones(admin);
    await admin.end();
  };
}

async function dropClones(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${TEMPLATE_DATABASE}_%`],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}
