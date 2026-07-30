#!/usr/bin/env node
import { Client } from 'pg';

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

const isFresh = process.argv.includes('--fresh');

async function main() {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) {
    throw new Error('TEST_DATABASE_URL has no database name');
  }

  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount && existing.rowCount > 0) {
      if (!isFresh) {
        console.log(
          `Test database "${dbName}" already exists. Re-run with --fresh if a migration was ` +
            'edited after it was applied here.',
        );
        return;
      }
      await client.query(`DROP DATABASE "${dbName.replace(/"/g, '')}" WITH (FORCE)`);
      console.log(`Dropped test database "${dbName}".`);
    }
    // CREATE DATABASE cannot be parameterized; dbName comes from our own env.
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    console.log(`Created test database "${dbName}".`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('db:test:setup failed:', e);
  process.exit(1);
});
