import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user, session } from '@openora/core/pam/schema/identity';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { SessionService, SessionNotFoundError } from '../service/session.service.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

let db: TestDb;

const service = () =>
  new SessionService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    identityReader: makeIdentityReader(),
  });

const seedSession = (userId: string, overrides: Partial<typeof session.$inferInsert> = {}) =>
  db.drizzle.db
    .insert(session)
    .values({
      userId,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning()
    .then(([row]) => row!);

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.execute(sql`TRUNCATE ${user} RESTART IDENTITY CASCADE`);
});

describe('SessionService', () => {
  it('flags only the caller session as current', async () => {
    const account = await seedUser(db);
    const here = await seedSession(account.id);
    await seedSession(account.id);

    const { items } = await service().listSessions({
      userId: account.id,
      currentSessionId: here.id,
      page: 1,
      limit: 20,
    });

    expect(items).toHaveLength(2);
    expect(items.filter((s) => s.current).map((s) => s.id)).toEqual([here.id]);
  });

  it('drops a revoked session from the active list', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id);
    await seedSession(account.id);

    await service().revokeSession(account.id, target.id);

    const active = await service().listSessions({
      userId: account.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });
    expect(active.total).toBe(1);
    expect(active.items.map((s) => s.id)).not.toContain(target.id);
  });

  it('expires the revoked session', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id);

    await service().revokeSession(account.id, target.id);

    const { items } = await service().listSessions({ userId: account.id, page: 1, limit: 20 });
    // revokeSession stamps expiresAt with the database clock, so read the same clock back:
    // an app-side Date.now() a millisecond behind the database would fail this on nothing.
    const { rows } = await db.drizzle.db.execute<{ now: string }>(sql`select now() as now`);
    expect(new Date(items[0]!.expiresAt).getTime()).toBeLessThanOrEqual(
      new Date(rows[0]!.now).getTime(),
    );
  });

  it('keeps the last-used timestamp when a session is revoked', async () => {
    const account = await seedUser(db);
    const lastUsed = new Date(Date.now() - 3_600_000);
    const target = await seedSession(account.id, { updatedAt: lastUsed });

    await service().revokeSession(account.id, target.id);

    const { items } = await service().listSessions({ userId: account.id, page: 1, limit: 20 });
    expect(new Date(items[0]!.updatedAt).getTime()).toBe(lastUsed.getTime());
  });

  it('refuses to revoke a session owned by someone else', async () => {
    const owner = await seedUser(db);
    const stranger = await seedUser(db);
    const target = await seedSession(owner.id);

    await expect(service().revokeSession(stranger.id, target.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('drops a player session idled past its own window from the active list, even though it has not expired yet', async () => {
    const account = await seedUser(db);
    await db.drizzle.db
      .update(user)
      .set({ autoLogoutDuration: '15m' })
      .where(eq(user.id, account.id));
    const idled = await seedSession(account.id, { lastSeenAt: minutesAgo(20) });
    const fresh = await seedSession(account.id, { lastSeenAt: minutesAgo(1) });

    const active = await service().listSessions({
      userId: account.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });

    expect(active.items.map((s) => s.id)).toEqual([fresh.id]);
    expect(active.items.map((s) => s.id)).not.toContain(idled.id);
  });

  it('does not idle out an admin session, which has no auto-logout window of its own', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const target = await seedSession(admin.id, { lastSeenAt: minutesAgo(60 * 24 * 30) });

    const active = await service().listSessions({
      userId: admin.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });

    expect(active.items.map((s) => s.id)).toContain(target.id);
  });

  it('excludes an idled-out player session from the platform-wide active list', async () => {
    const account = await seedUser(db);
    await db.drizzle.db
      .update(user)
      .set({ autoLogoutDuration: '15m' })
      .where(eq(user.id, account.id));
    const idled = await seedSession(account.id, { lastSeenAt: minutesAgo(20) });

    const { items } = await service().listAllActiveSessions({ page: 1, limit: 20 });

    expect(items.map((s) => s.id)).not.toContain(idled.id);
  });
});
