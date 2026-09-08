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
  });

  // CONFLICT is asserted rather than "it threw": the port narrows on the constraint
  // name, so a broken narrowing that relabels any 23505 as a username clash has to fail
  // here. The converse case - some other unique constraint reaching this catch - is not
  // testable through the port, which writes the username column and nothing else.
  it('rejects a handle already taken, case-insensitively', async () => {
    await seedUser(db, { name: 'taken_name', username: 'taken_name' });
    const account = await seedUser(db, { name: 'free_name', username: 'free_name' });

    await expect(commands().setUsername(account.id, 'TAKEN_NAME')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
