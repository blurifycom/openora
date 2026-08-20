import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MigrationMeta } from 'drizzle-orm/migrator';

const { calls, poolInstances, failOnSql, FakePool, readMigrationFilesMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const poolInstances: unknown[] = [];
  const failOnSql = { value: null as string | null };

  class FakeClient {
    readonly query = vi.fn(async (sql: string) => {
      if (failOnSql.value !== null && sql === failOnSql.value) {
        throw new Error(`boom: ${sql}`);
      }
      calls.push(sql);
      return { rows: [] };
    });
    readonly release = vi.fn();
  }

  class FakePool {
    readonly query = vi.fn(async (sql: string) => {
      if (failOnSql.value !== null && sql === failOnSql.value) {
        throw new Error(`boom: ${sql}`);
      }
      calls.push(sql);
      return { rows: [] };
    });
    readonly connect = vi.fn(async () => new FakeClient());
    readonly end = vi.fn(async () => {
      calls.push('end');
    });
    constructor(readonly opts: { connectionString: string }) {
      poolInstances.push(this);
    }
  }

  const readMigrationFilesMock = vi.fn(() => [] as MigrationMeta[]);

  return { calls, poolInstances, failOnSql, FakePool, readMigrationFilesMock };
});

vi.mock('pg', () => ({ Pool: FakePool }));
vi.mock('drizzle-orm/migrator', () => ({ readMigrationFiles: readMigrationFilesMock }));

const { runMigrations, applyMigrationsIndividually, withMigrationAdvisoryLock } =
  await import('../migrate.js');

describe('runMigrations', () => {
  beforeEach(() => {
    calls.length = 0;
    poolInstances.length = 0;
    failOnSql.value = null;
    readMigrationFilesMock.mockClear();
  });

  it('runs extensions, then preSql, before reading pending migrations', async () => {
    await runMigrations({
      migrationsFolder: '/tmp/migrations',
      databaseUrl: 'postgres://test',
      extensions: ['pg_trgm'],
      preSql: ['UPDATE foo SET bar = 1', 'UPDATE baz SET qux = 2'],
    });

    const presqlIndex = calls.indexOf('UPDATE foo SET bar = 1');
    const readIndex = calls.indexOf('SELECT hash FROM "drizzle"."__drizzle_migrations"');
    expect(calls).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(calls).toEqual(
      expect.arrayContaining(['UPDATE foo SET bar = 1', 'UPDATE baz SET qux = 2']),
    );
    expect(presqlIndex).toBeLessThan(readIndex);
    expect(calls).toContain('end');
  });

  it('is a no-op (beyond bookkeeping) when preSql is omitted', async () => {
    await runMigrations({
      migrationsFolder: '/tmp/migrations',
      databaseUrl: 'postgres://test',
    });

    expect(calls).not.toContain(undefined);
    expect(calls).toContain('end');
  });

  it('runs migration-specific SQL inside the selected migration transaction', async () => {
    readMigrationFilesMock.mockReturnValueOnce(migrations);

    await runMigrations({
      migrationsFolder: '/tmp/migrations',
      databaseUrl: 'postgres://test',
      preMigrationSql: (migration) =>
        migration.hash === 'one' ? ['INSERT INTO wallet_balance SELECT * FROM wallet'] : [],
    });

    expect(calls.indexOf('BEGIN')).toBeLessThan(
      calls.indexOf('INSERT INTO wallet_balance SELECT * FROM wallet'),
    );
    expect(calls.indexOf('INSERT INTO wallet_balance SELECT * FROM wallet')).toBeLessThan(
      calls.indexOf(migrations[0].sql[0]),
    );
  });

  it('closes the pool even when a preSql statement throws, and never reads pending migrations', async () => {
    failOnSql.value = 'THIS WILL FAIL';

    await expect(
      runMigrations({
        migrationsFolder: '/tmp/migrations',
        databaseUrl: 'postgres://test',
        preSql: ['THIS WILL FAIL'],
      }),
    ).rejects.toThrow('boom: THIS WILL FAIL');

    expect(readMigrationFilesMock).not.toHaveBeenCalled();
    expect(calls).toContain('end');
  });
});

const migrations: MigrationMeta[] = [
  {
    sql: ["ALTER TYPE room_category ADD VALUE 'private-chats';"],
    folderMillis: 1,
    hash: 'one',
    bps: true,
  },
  {
    sql: ["UPDATE chat_room SET category = 'private-chats';"],
    folderMillis: 2,
    hash: 'two',
    bps: true,
  },
];

describe('applyMigrationsIndividually', () => {
  it('commits each migration file before applying the next one', async () => {
    const apply = vi.fn(async () => undefined);

    await applyMigrationsIndividually({ migrations, apply });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, migrations[0]);
    expect(apply).toHaveBeenNthCalledWith(2, migrations[1]);
  });
});

describe('withMigrationAdvisoryLock', () => {
  it('holds the journal lock until the migration work completes', async () => {
    const query = vi.fn(async () => undefined);
    const action = vi.fn(async () => undefined);

    await withMigrationAdvisoryLock({ query }, 'drizzle.__drizzle_migrations_chat', action);

    expect(query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock(hashtext($1))', [
      'drizzle.__drizzle_migrations_chat',
    ]);
    expect(action).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock(hashtext($1))', [
      'drizzle.__drizzle_migrations_chat',
    ]);
  });

  it('releases the lock when migration work fails', async () => {
    const query = vi.fn(async () => undefined);
    const failure = new Error('migration failed');

    await expect(
      withMigrationAdvisoryLock({ query }, 'drizzle.__drizzle_migrations_chat', async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock(hashtext($1))', [
      'drizzle.__drizzle_migrations_chat',
    ]);
  });
});
