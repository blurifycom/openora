import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';

// The shipped backfill statement, read from the migration itself so this test cannot
// drift from what actually runs. Statement 2 of 3, between the ADD COLUMN and the index.
const BACKFILL_SQL = readFileSync(
  fileURLToPath(new URL('../drizzle/migrations/0007_fuzzy_barracuda.sql', import.meta.url)),
  'utf8',
).split('--> statement-breakpoint')[1]!;

let db: TestDb;

async function seedLegacy(displayName: string | null, name = 'Fallback Name') {
  const userId = randomUUID();
  await db.drizzle.db.insert(user).values({
    id: userId,
    name,
    username: `seed_${userId.replaceAll('-', '').slice(0, 13)}`,
    email: `${userId}@legacy.test`,
    role: 'player',
  });
  if (displayName !== null) {
    await db.drizzle.db.insert(player).values({ userId, displayName });
  }
  return userId;
}

/** Re-runs the backfill against rows that look like they predate the username column. */
async function runBackfill() {
  await db.drizzle.db.execute(sql`ALTER TABLE "user" ALTER COLUMN username DROP NOT NULL`);
  await db.drizzle.db.execute(sql`UPDATE "user" SET username = NULL`);
  await db.drizzle.db.execute(sql.raw(BACKFILL_SQL));
  await db.drizzle.db.execute(sql`ALTER TABLE "user" ALTER COLUMN username SET NOT NULL`);
  const rows = await db.drizzle.db.select({ id: user.id, username: user.username }).from(user);
  return new Map(rows.map((r) => [r.id, r.username]));
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player}, ${user} RESTART IDENTITY CASCADE`);
});

describe('0007 username backfill', () => {
  it('sanitises a legacy display name into a valid handle', async () => {
    const id = await seedLegacy("Alice O'Hara!");

    expect((await runBackfill()).get(id)).toBe('alice_o_hara_');
  });

  it('falls back to the user name, then to a generic handle', async () => {
    const noPlayerRow = await seedLegacy(null, 'Bob Builder');
    const tooShort = await seedLegacy('ab');

    const byId = await runBackfill();
    expect(byId.get(noPlayerRow)).toBe('bob_builder');
    expect(byId.get(tooShort)).toBe('player');
  });

  it('gives colliding legacy names globally unique handles', async () => {
    const ids = await Promise.all([
      seedLegacy('Duplicate'),
      seedLegacy('Duplicate'),
      seedLegacy('Duplicate'),
    ]);

    const byId = await runBackfill();
    const handles = ids.map((id) => byId.get(id));
    expect(new Set(handles).size).toBe(3);
    expect(handles).toContain('duplicate');
  });

  it('never exceeds the 20 character username limit', async () => {
    const ids = await Promise.all([
      seedLegacy('A Very Long Display Name Indeed'),
      seedLegacy('A Very Long Display Name Indeed'),
    ]);

    const byId = await runBackfill();
    for (const id of ids) {
      const handle = byId.get(id);
      expect(handle).toMatch(/^[a-z0-9_]{3,20}$/);
    }
  });

  it('gives non-player accounts a username too, so the column can be NOT NULL', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(user).values({
      id: userId,
      name: 'Admin',
      username: `seed_${userId.replaceAll('-', '').slice(0, 13)}`,
      email: `${userId}@legacy.test`,
      role: 'admin',
    });

    expect((await runBackfill()).get(userId)).toBe('admin');
  });

  it('satisfies the unique index it runs before', async () => {
    await Promise.all(Array.from({ length: 25 }, () => seedLegacy('Same Name')));

    const handles = [...(await runBackfill()).values()];
    expect(new Set(handles.map((h) => h?.toLowerCase())).size).toBe(handles.length);
  });
});
