#!/usr/bin/env node
/**
 * Create the integration-test database if it doesn't exist. Idempotent.
 *
 *   pnpm db:test:setup
 *
 * Connects to the `postgres` maintenance DB on the same server as
 * TEST_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/oss_igaming_test)
 * and runs CREATE DATABASE. Migrations are applied by the test harness
 * (@oss/testing setupTestDb), not here.
 */
import { Client } from 'pg';

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

async function main() {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) throw new Error('TEST_DATABASE_URL has no database name');

  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount && existing.rowCount > 0) {
      console.log(`Test database "${dbName}" already exists.`);
      return;
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
