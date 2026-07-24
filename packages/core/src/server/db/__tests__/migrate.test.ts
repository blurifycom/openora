import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, poolInstances, failOnSql, FakePool, migrateMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const poolInstances: unknown[] = [];
  const failOnSql = { value: null as string | null };

  class FakePool {
    readonly query = vi.fn(async (sql: string) => {
      if (failOnSql.value !== null && sql === failOnSql.value) {
        throw new Error(`boom: ${sql}`);
      }
      calls.push(sql);
      return { rows: [] };
    });
    readonly end = vi.fn(async () => {
      calls.push('end');
    });
    constructor(readonly opts: { connectionString: string }) {
      poolInstances.push(this);
    }
  }

  const migrateMock = vi.fn(async () => {
    calls.push('migrate');
  });

  return { calls, poolInstances, failOnSql, FakePool, migrateMock };
});

vi.mock('pg', () => ({ Pool: FakePool }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: migrateMock }));

const { runMigrations } = await import('../migrate.js');

describe('runMigrations', () => {
  beforeEach(() => {
    calls.length = 0;
    poolInstances.length = 0;
    failOnSql.value = null;
    migrateMock.mockClear();
  });

  it('runs extensions, then preSql, then the drizzle migrator, in that order', async () => {
    await runMigrations({
      migrationsFolder: '/tmp/migrations',
      databaseUrl: 'postgres://test',
      extensions: ['pg_trgm'],
      preSql: ['UPDATE foo SET bar = 1', 'UPDATE baz SET qux = 2'],
    });

    expect(calls).toEqual([
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      'UPDATE foo SET bar = 1',
      'UPDATE baz SET qux = 2',
      'migrate',
      'end',
    ]);
  });

  it('is a no-op when preSql is omitted', async () => {
    await runMigrations({
      migrationsFolder: '/tmp/migrations',
      databaseUrl: 'postgres://test',
    });

    expect(calls).toEqual(['migrate', 'end']);
  });

  it('closes the pool even when a preSql statement throws, and never reaches the migrator', async () => {
    failOnSql.value = 'THIS WILL FAIL';

    await expect(
      runMigrations({
        migrationsFolder: '/tmp/migrations',
        databaseUrl: 'postgres://test',
        preSql: ['THIS WILL FAIL'],
      }),
    ).rejects.toThrow('boom: THIS WILL FAIL');

    expect(calls).not.toContain('migrate');
    expect(calls).toContain('end');
  });
});
