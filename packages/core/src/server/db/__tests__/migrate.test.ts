import { describe, expect, it, vi } from 'vitest';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { applyMigrationsIndividually } from '../migrate.js';

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
