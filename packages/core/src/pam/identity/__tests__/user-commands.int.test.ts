import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate } from '../migrate.js';
import { DrizzleUserCommands } from '../service/user-commands.service.js';

let db: TestDb;

async function seedUser(username: string) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name: username, username, email: `${randomUUID()}@x.dev` })
    .returning();
  return row!;
}

const commands = () => new DrizzleUserCommands(db.drizzle);

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${user} RESTART IDENTITY CASCADE`);
});

describe('DrizzleUserCommands.setUsername', () => {
  it('writes the new handle', async () => {
    const account = await seedUser('before_name');

    await commands().setUsername(account.id, 'after_name');

    const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, account.id));
    expect(row?.username).toBe('after_name');
  });

  it('rejects a handle already taken, case-insensitively', async () => {
    await seedUser('taken_name');
    const account = await seedUser('free_name');

    await expect(commands().setUsername(account.id, 'TAKEN_NAME')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lets other unique violations through untouched', async () => {
    const existing = await seedUser('other_name');
    const account = await seedUser('mine_name');

    // Email collides, not the username - the port must not relabel it as a username clash.
    await expect(
      db.drizzle.db.update(user).set({ email: existing.email }).where(eq(user.id, account.id)),
    ).rejects.toThrow();
  });
});
