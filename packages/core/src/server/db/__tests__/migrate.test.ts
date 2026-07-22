import { describe, expect, it, vi } from 'vitest';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { applyMigrationsIndividually, withMigrationAdvisoryLock } from '../migrate.js';

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
