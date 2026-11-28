#!/usr/bin/env node
import { Client } from 'pg';

const PATTERNS = ['test\\_%', 'oss_igaming_test_tpl\\_%', 'unseeded\\_%'];

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5434/oss_igaming_test';

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
