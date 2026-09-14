#!/usr/bin/env node
import { Client } from 'pg';

// Both integration tiers name their per-suite databases after the run that created them
// and sweep only their own in teardown, so a run killed outright (a cancelled CI job, a
// ctrl-C) leaves its databases behind. This clears every one of them, which is only safe
// while no test run is in progress.
const PATTERNS = ['test\\_%', 'oss_igaming_test_tpl\\_%', 'unseeded\\_%'];

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

async function main() {
  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE ANY($1)`,
      [PATTERNS],
    );
    for (const { datname } of rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname.replace(/"/g, '')}" WITH (FORCE)`);
    }
    console.log(`Dropped ${rows.length} leftover test database(s).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('db:clean:test failed:', e);
  process.exit(1);
});
