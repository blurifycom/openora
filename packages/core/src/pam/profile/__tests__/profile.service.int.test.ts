import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '../schema/index.js';
import { migrate } from '../migrate.js';
import { ProfileService } from '../service/profile.service.js';

let db: TestDb;

function makeService(): ProfileService {
  return new ProfileService(db.drizzle);
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player One',
      username: randomUUID().replaceAll('-', '').slice(0, 20),
      email: `${randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, displayName: 'Player One', ...overrides })
    .returning();
  return row!;
}

async function playersFor(userId: string) {
  return db.drizzle.db.select().from(player).where(eq(player.userId, userId));
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player}, ${user} RESTART IDENTITY CASCADE`);
});

describe('ProfileService.getMyProfile (real PG)', () => {
  it('materializes a player row from the users username on first access', async () => {
    const svc = makeService();
    const account = await seedUser({ name: 'Jordan', username: 'jordan_player' });

    const profile = await svc.getMyProfile(account.id);

    expect(profile).toMatchObject({
      userId: account.id,
      username: 'jordan_player',
      email: account.email,
    });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('returns the existing row without inserting a second one on a later call', async () => {
    const svc = makeService();
    const account = await seedUser();
    await seedPlayer(account.id, { displayName: 'Existing', country: 'US' });

    const profile = await svc.getMyProfile(account.id);

    expect(profile).toMatchObject({ username: account.username, country: 'US' });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('creates exactly one player row when two first accesses race on the same user', async () => {
    const svc = makeService();
    const account = await seedUser();

    const [a, b] = await Promise.all([svc.getMyProfile(account.id), svc.getMyProfile(account.id)]);

    expect(a.id).toBe(b.id);
    expect(await playersFor(account.id)).toHaveLength(1);
  });
});

describe('ProfileService.updateMyProfile (real PG)', () => {
  it('persists profile fields and returns the mapped player with email', async () => {
    const svc = makeService();
    const account = await seedUser({ name: 'Player One' });
    await seedPlayer(account.id, { country: null });

    const result = await svc.updateMyProfile(account.id, { country: 'US' });

    expect(result).toMatchObject({ country: 'US', email: account.email });
    const [row] = await playersFor(account.id);
    expect(row?.country).toBe('US');
  });

  it('materializes the profile first when update is the first call for a user', async () => {
    const svc = makeService();
    const account = await seedUser({ name: 'Fresh', username: 'fresh_player' });

    const result = await svc.updateMyProfile(account.id, { currency: 'EUR' });

    expect(result).toMatchObject({ username: 'fresh_player', currency: 'EUR' });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('leaves other players untouched', async () => {
    const svc = makeService();
    const account = await seedUser();
    const other = await seedUser();
    await seedPlayer(account.id, { country: 'US' });
    await seedPlayer(other.id, { country: 'CA' });

    await svc.updateMyProfile(account.id, { country: 'FR' });

    const [otherRow] = await playersFor(other.id);
    expect(otherRow?.country).toBe('CA');
  });
});
