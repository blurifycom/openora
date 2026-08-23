import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user, session } from '@openora/core/pam/schema/identity';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { SessionService, SessionNotFoundError } from '../service/session.service.js';

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
    expect(new Date(items[0]!.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('refuses to revoke a session owned by someone else', async () => {
    const owner = await seedUser(db);
    const stranger = await seedUser(db);
    const target = await seedSession(owner.id);

    await expect(service().revokeSession(stranger.id, target.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});
