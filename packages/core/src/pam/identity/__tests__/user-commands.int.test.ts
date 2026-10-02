import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate } from '../migrate.js';
import { DrizzleUserCommands } from '../service/user-commands.service.js';

let db: TestDb;

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
    const account = await seedUser(db, { name: 'before_name', username: 'before_name' });

    await commands().setUsername(account.id, 'after_name');

    const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, account.id));
    expect(row?.username).toBe('after_name');
    expect(row?.name).toBe('after_name');
  });

  it('rejects a handle already taken, case-insensitively', async () => {
    await seedUser(db, { name: 'taken_name', username: 'taken_name' });
    const account = await seedUser(db, { name: 'free_name', username: 'free_name' });

    await expect(commands().setUsername(account.id, 'TAKEN_NAME')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it("writes inside the caller's transaction and rolls back with it", async () => {
    const account = await seedUser(db, { name: 'kept_name', username: 'kept_name' });

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await commands().setUsername(account.id, 'rolled_back', tx);
        throw new Error('caller aborts');
      }),
    ).rejects.toThrow('caller aborts');

    const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, account.id));
    expect(row?.username).toBe('kept_name');
  });

  it('maps a taken handle inside a transaction to CONFLICT and aborts it', async () => {
    await seedUser(db, { name: 'held_name', username: 'held_name' });
    const account = await seedUser(db, { name: 'mover_name', username: 'mover_name' });

    await expect(
      db.drizzle.db.transaction((tx) => commands().setUsername(account.id, 'HELD_NAME', tx)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, account.id));
    expect(row?.username).toBe('mover_name');
  });
});
