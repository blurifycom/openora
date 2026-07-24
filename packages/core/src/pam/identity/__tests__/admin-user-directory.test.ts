import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, NO_CLIENT_META } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { DrizzleAdminUserDirectory } from '../admin-user-directory.js';

let db: TestDb;

function makeDirectory() {
  const emit = vi.fn();
  return {
    dir: new DrizzleAdminUserDirectory(db.drizzle, mock<EventBus>({ emit, on: vi.fn() })),
    emit,
  };
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Alice',
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, displayName: 'alice', ...overrides })
    .returning();
  return row!;
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

describe('DrizzleAdminUserDirectory.update (real PG)', () => {
  it('emits deactivated and persists the flip when isActive goes true -> false', async () => {
    const { dir, emit } = makeDirectory();
    const account = await seedUser({ isActive: true });
    const actorId = randomUUID();

    const updated = await dir.update(account.id, { isActive: false }, actorId, NO_CLIENT_META);

    expect(updated).toMatchObject({ isActive: false });
    const [stored] = await db.drizzle.db.select().from(user).where(eq(user.id, account.id));
    expect(stored?.isActive).toBe(false);
    expect(emit).toHaveBeenCalledWith('identity.user.deactivated', {
      userId: account.id,
      actorId,
      ip: null,
      userAgent: null,
    });
  });

  it('emits reactivated when isActive goes false -> true', async () => {
    const { dir, emit } = makeDirectory();
    const account = await seedUser({ isActive: false });
    const actorId = randomUUID();

    await dir.update(account.id, { isActive: true }, actorId, NO_CLIENT_META);

    expect(emit).toHaveBeenCalledWith('identity.user.reactivated', {
      userId: account.id,
      actorId,
      ip: null,
      userAgent: null,
    });
  });

  it('stays quiet when isActive is written unchanged', async () => {
    const { dir, emit } = makeDirectory();
    const account = await seedUser({ isActive: true });

    await dir.update(account.id, { isActive: true }, randomUUID());

    expect(emit).not.toHaveBeenCalled();
  });

  it('stays quiet on a role-only update but still writes the role', async () => {
    const { dir, emit } = makeDirectory();
    const account = await seedUser({ isActive: true });

    const updated = await dir.update(account.id, { role: 'admin' }, randomUUID());

    expect(updated).toMatchObject({ role: 'admin' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns null for an unknown user', async () => {
    const { dir, emit } = makeDirectory();

    expect(await dir.update(randomUUID(), { isActive: false }, randomUUID())).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('DrizzleAdminUserDirectory reads (real PG)', () => {
  it('counts every user row', async () => {
    const { dir } = makeDirectory();
    await seedUser();
    await seedUser();

    expect(await dir.count()).toBe(2);
  });

  it('gets a single user, or null when unknown', async () => {
    const { dir } = makeDirectory();
    const account = await seedUser();

    expect(await dir.get(account.id)).toMatchObject({ id: account.id, email: account.email });
    expect(await dir.get(randomUUID())).toBeNull();
  });

  it('filters the list by an email substring and reports the filtered total', async () => {
    const { dir } = makeDirectory();
    await seedUser({ email: 'match-me@example.com' });
    await seedUser({ email: 'other@example.com' });

    const result = await dir.list({ page: 1, limit: 10, search: 'match-me' });

    expect(result.total).toBe(1);
    expect(result.rows[0]?.email).toBe('match-me@example.com');
  });

  it('sorts by email ascending when asked', async () => {
    const { dir } = makeDirectory();
    await seedUser({ email: 'b@example.com' });
    await seedUser({ email: 'a@example.com' });

    const result = await dir.list({ page: 1, limit: 10, sortBy: 'email', sortOrder: 'asc' });

    expect(result.rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('pages while the total covers the whole set', async () => {
    const { dir } = makeDirectory();
    await seedUser();
    await seedUser();
    await seedUser();

    const result = await dir.list({ page: 2, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(1);
  });
});

describe('DrizzleAdminUserDirectory.lookupPlayers (real PG)', () => {
  it('returns an empty array for no ids', async () => {
    const { dir } = makeDirectory();

    expect(await dir.lookupPlayers([])).toEqual([]);
  });

  it('joins the email from the user table onto the player summary', async () => {
    const { dir } = makeDirectory();
    const account = await seedUser({ email: 'alice@example.com' });
    await seedPlayer(account.id, { displayName: 'alice', kycStatus: 'verified' });

    const [summary] = await dir.lookupPlayers([account.id]);

    expect(summary).toEqual({
      userId: account.id,
      username: 'alice',
      email: 'alice@example.com',
      kycStatus: 'verified',
      language: 'en',
    });
  });

  it('skips a user id that has no player profile', async () => {
    const { dir } = makeDirectory();
    const account = await seedUser();

    expect(await dir.lookupPlayers([account.id])).toEqual([]);
  });

  it('normalizes the deprecated verified value to approved (the single read boundary every admin consumer goes through)', async () => {
    const dir = makeDirWithSelect([
      [{ userId: 'u1', username: 'alice', kycStatus: 'verified', email: 'alice@example.com' }],
    ]);
    const [summary] = await dir.lookupPlayers(['u1']);
    expect(summary?.kycStatus).toBe('approved');
  });
});

describe('DrizzleAdminUserDirectory.findPlayerIds (real PG)', () => {
  it('unions email and displayName matches into a deduped id set', async () => {
    const { dir } = makeDirectory();
    const byEmailOnly = await seedUser({ email: 'anna@example.com' });
    const byBoth = await seedUser({ email: 'anton@example.com' });
    await seedPlayer(byBoth.id, { displayName: 'anton' });
    const byNameOnly = await seedUser({ email: 'zoe@example.com' });
    await seedPlayer(byNameOnly.id, { displayName: 'annabel' });

    const ids = await dir.findPlayerIds('an');

    expect([...ids].sort()).toEqual([byEmailOnly.id, byBoth.id, byNameOnly.id].sort());
  });

  it('returns nothing when the term matches neither column', async () => {
    const { dir } = makeDirectory();
    await seedUser({ email: 'alice@example.com' });

    expect(await dir.findPlayerIds('zzzz')).toEqual([]);
  });
});
