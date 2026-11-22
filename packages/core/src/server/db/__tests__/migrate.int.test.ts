import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  waitForAdvisoryLockWaiter,
  type TestDb,
} from '../../../testing/real-infra.js';
import { runMigrations, withMigrationAdvisoryLock } from '../migrate.js';

type Fixture = { tag: string; sql: string };

const root = mkdtempSync(join(tmpdir(), 'run-migrations-'));
let folderCount = 0;
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([]);
});

afterAll(async () => {
  await db.drop();
  rmSync(root, { recursive: true, force: true });
});

function writeFolder(migrations: Fixture[]): string {
  const dir = join(root, String(folderCount++));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const entries = migrations.map((migration, idx) => ({
    idx,
    version: '7',
    when: 1_700_000_000_000 + idx,
    tag: migration.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  for (const migration of migrations) {
    writeFileSync(join(dir, `${migration.tag}.sql`), migration.sql);
  }
  return dir;
}

async function rows<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
  const result = await db.drizzle.db.execute<T>(query);
  return result.rows;
}

async function exists(table: string): Promise<boolean> {
  const [row] = await rows<{ found: string | null }>(sql`select to_regclass(${table}) as found`);
  return row?.found !== null;
}

async function journal(table: string) {
  return rows<{ hash: string; created_at: string }>(
    sql`select hash, created_at from drizzle.${sql.identifier(table)} order by id`,
  );
}

describe('runMigrations', () => {
  it('applies a journal from zero, committing each file before the next', async () => {
    const migrationsFolder = writeFolder([
      {
        tag: '0000_enum',
        sql: `CREATE TYPE mig_zero_kind AS ENUM ('a');--> statement-breakpoint
CREATE TABLE mig_zero_item (id serial PRIMARY KEY, kind mig_zero_kind NOT NULL);`,
      },
      {
        tag: '0001_use_new_value',
        sql: `ALTER TYPE mig_zero_kind ADD VALUE 'b';`,
      },
      {
        tag: '0002_insert_new_value',
        sql: `INSERT INTO mig_zero_item (kind) VALUES ('b');`,
      },
    ]);

    await runMigrations({
      migrationsFolder,
      migrationsTable: 'mig_zero',
      databaseUrl: db.url,
    });

    const items = await rows<{ kind: string }>(sql`select kind from mig_zero_item`);
    expect(items).toEqual([{ kind: 'b' }]);
    expect((await journal('mig_zero')).map((row) => Number(row.created_at))).toEqual([
      1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002,
    ]);
  });

  it('is idempotent: a second run applies nothing and does not re-run a migration', async () => {
    const migrationsFolder = writeFolder([
      { tag: '0000_create', sql: 'CREATE TABLE mig_idem_item (id int);' },
      { tag: '0001_seed', sql: 'INSERT INTO mig_idem_item VALUES (1);' },
    ]);
    const options = { migrationsFolder, migrationsTable: 'mig_idem', databaseUrl: db.url };

    await runMigrations(options);
    await runMigrations(options);

    expect(await rows(sql`select id from mig_idem_item`)).toEqual([{ id: 1 }]);
    expect(await journal('mig_idem')).toHaveLength(2);
  });

  it('serializes concurrent runners of the same journal with the advisory lock', async () => {
    const migrationsFolder = writeFolder([
      {
        tag: '0000_slow_create',
        sql: `SELECT pg_sleep(0.3);--> statement-breakpoint
CREATE TABLE mig_race_item (id int);`,
      },
      { tag: '0001_seed', sql: 'INSERT INTO mig_race_item VALUES (1);' },
    ]);
    const options = { migrationsFolder, migrationsTable: 'mig_race', databaseUrl: db.url };

    await Promise.all([runMigrations(options), runMigrations(options), runMigrations(options)]);

    expect(await rows(sql`select id from mig_race_item`)).toEqual([{ id: 1 }]);
    expect(await journal('mig_race')).toHaveLength(2);
  });

  it('rolls a failing file back whole, keeps earlier files, and leaves no journal row for it', async () => {
    const migrationsFolder = writeFolder([
      { tag: '0000_create', sql: 'CREATE TABLE mig_fail_ok (id int);' },
      {
        tag: '0001_broken',
        sql: `CREATE TABLE mig_fail_half (id int);--> statement-breakpoint
SELECT * FROM mig_fail_missing;`,
      },
      { tag: '0002_never', sql: 'CREATE TABLE mig_fail_after (id int);' },
    ]);

    await expect(
      runMigrations({ migrationsFolder, migrationsTable: 'mig_fail', databaseUrl: db.url }),
    ).rejects.toThrow('mig_fail_missing');

    expect(await exists('mig_fail_ok')).toBe(true);
    expect(await exists('mig_fail_half')).toBe(false);
    expect(await exists('mig_fail_after')).toBe(false);
    expect(await journal('mig_fail')).toHaveLength(1);
  });

  it('retries a previously failed file on the next run once it is fixed', async () => {
    const broken = writeFolder([{ tag: '0000_create', sql: 'SELECT * FROM mig_retry_missing;' }]);
    const options = { migrationsTable: 'mig_retry', databaseUrl: db.url };
    await expect(runMigrations({ ...options, migrationsFolder: broken })).rejects.toThrow();

    const fixed = writeFolder([
      { tag: '0000_create', sql: 'CREATE TABLE mig_retry_item (id int);' },
    ]);
    await runMigrations({ ...options, migrationsFolder: fixed });

    expect(await exists('mig_retry_item')).toBe(true);
    expect(await journal('mig_retry')).toHaveLength(1);
  });

  it('runs extensions and preSql before applying pending migrations', async () => {
    const migrationsFolder = writeFolder([
      {
        tag: '0000_use_presql',
        sql: "INSERT INTO mig_pre_item SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm';",
      },
    ]);

    await runMigrations({
      migrationsFolder,
      migrationsTable: 'mig_pre',
      databaseUrl: db.url,
      extensions: ['pg_trgm'],
      preSql: ['CREATE TABLE mig_pre_item (found bigint)'],
    });

    expect(await rows(sql`select found::int as found from mig_pre_item`)).toEqual([{ found: 1 }]);
  });

  it('runs lockedPreSql before and postSql after the pending migrations', async () => {
    const migrationsFolder = writeFolder([
      { tag: '0000_seed', sql: "INSERT INTO mig_hook_item VALUES ('migration');" },
    ]);

    await runMigrations({
      migrationsFolder,
      migrationsTable: 'mig_hook',
      databaseUrl: db.url,
      lockedPreSql: ['CREATE TABLE mig_hook_item (step text, seq serial)'],
      postSql: ["INSERT INTO mig_hook_item (step) VALUES ('post')"],
    });

    expect(await rows(sql`select step from mig_hook_item order by seq`)).toEqual([
      { step: 'migration' },
      { step: 'post' },
    ]);
  });

  it('refuses an extension name outside the allowlist without touching the database', async () => {
    const migrationsFolder = writeFolder([{ tag: '0000_noop', sql: 'SELECT 1;' }]);

    await expect(
      runMigrations({
        migrationsFolder,
        migrationsTable: 'mig_ext',
        databaseUrl: db.url,
        extensions: ['pg_trgm; DROP TABLE mig_zero_item'],
      }),
    ).rejects.toThrow(/Invalid extension name/);

    expect(await exists('drizzle.mig_ext')).toBe(false);
    expect(await exists('mig_zero_item')).toBe(true);
  });

  it('closes its connections and never reads migrations when a preSql statement throws', async () => {
    const migrationsFolder = join(root, 'does-not-exist');

    await expect(
      runMigrations({
        migrationsFolder,
        migrationsTable: 'mig_prefail',
        databaseUrl: db.url,
        preSql: ['SELECT * FROM mig_prefail_missing'],
      }),
    ).rejects.toThrow('mig_prefail_missing');

    expect(await exists('drizzle.mig_prefail')).toBe(false);
  });

  it('treats current hashes aliased from an applied legacy hash as applied', async () => {
    const legacy = writeFolder([
      { tag: '0000_baseline', sql: 'CREATE TABLE mig_alias_base (id int);' },
    ]);
    const options = { migrationsTable: 'mig_alias', databaseUrl: db.url };
    await runMigrations({ ...options, migrationsFolder: legacy });
    const [applied] = await journal('mig_alias');
    const rebaselined = writeFolder([
      { tag: '0000_split_a', sql: 'CREATE TABLE mig_alias_a (id int);' },
      { tag: '0001_split_b', sql: 'CREATE TABLE mig_alias_b (id int);' },
    ]);
    const hashes = readMigrationFiles({ migrationsFolder: rebaselined }).map(
      (migration) => migration.hash,
    );

    await runMigrations({
      ...options,
      migrationsFolder: rebaselined,
      migrationHashAliases: { [applied?.hash ?? '']: hashes },
    });

    expect(await exists('mig_alias_a')).toBe(false);
    expect(await exists('mig_alias_b')).toBe(false);
  });

  it('sets lock_timeout inside each migration transaction', async () => {
    const migrationsFolder = writeFolder([
      {
        tag: '0000_capture',
        sql: "CREATE TABLE mig_lt_item AS SELECT current_setting('lock_timeout') AS value;",
      },
      {
        tag: '0001_capture_again',
        sql: "INSERT INTO mig_lt_item SELECT current_setting('lock_timeout');",
      },
    ]);

    await runMigrations({
      migrationsFolder,
      migrationsTable: 'mig_lt',
      databaseUrl: db.url,
      lockTimeout: '5s',
    });

    expect(await rows(sql`select value from mig_lt_item`)).toEqual([
      { value: '5s' },
      { value: '5s' },
    ]);
  });

  it('refuses a malformed lockTimeout before applying anything', async () => {
    const migrationsFolder = writeFolder([{ tag: '0000_noop', sql: 'SELECT 1;' }]);

    await expect(
      runMigrations({
        migrationsFolder,
        migrationsTable: 'mig_badlt',
        databaseUrl: db.url,
        lockTimeout: "5s'; DROP",
      }),
    ).rejects.toThrow('Invalid lock timeout');

    expect(await exists('drizzle.mig_badlt')).toBe(false);
  });
});

describe('withMigrationAdvisoryLock', () => {
  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    return client;
  }

  it('holds the lock until the work completes, then lets the next session in', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const holder = withMigrationAdvisoryLock(first, 'lock.holds', async () => {
        order.push('first-start');
        await gate;
        order.push('first-end');
      });
      await vi.waitFor(() => expect(order).toEqual(['first-start']));
      const waiter = withMigrationAdvisoryLock(second, 'lock.holds', async () => {
        order.push('second');
      });
      await waitForAdvisoryLockWaiter(db);
      expect(order).toEqual(['first-start']);

      release();
      await Promise.all([holder, waiter]);

      expect(order).toEqual(['first-start', 'first-end', 'second']);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it('releases the lock when the work fails', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);

    try {
      await expect(
        withMigrationAdvisoryLock(first, 'lock.fails', async () => {
          throw new Error('migration failed');
        }),
      ).rejects.toThrow('migration failed');

      const { rows: free } = await second.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('lock.fails')) AS acquired",
      );
      expect(free[0]?.acquired).toBe(true);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
});
