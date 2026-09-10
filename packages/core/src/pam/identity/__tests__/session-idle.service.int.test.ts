import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user, session } from '@openora/core/pam/schema/identity';
import type { AutoLogoutDuration } from '@openora/core/contracts';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { SessionIdleService } from '../service/session-idle.service.js';

let db: TestDb;

const service = (events = makeEventBus()) =>
  new SessionIdleService({
    drizzle: db.drizzle,
    events,
    identityReader: makeIdentityReader(),
  });

const seedSession = (userId: string, lastSeenAt: Date | null) =>
  db.drizzle.db
    .insert(session)
    .values({
      userId,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
      lastSeenAt,
    })
    .returning()
    .then(([row]) => row!);

const setWindow = (userId: string, autoLogoutDuration: AutoLogoutDuration) =>
  db.drizzle.db.update(user).set({ autoLogoutDuration }).where(eq(user.id, userId));

const readSession = (id: string) =>
  db.drizzle.db
    .select()
    .from(session)
    .where(eq(session.id, id))
    .then(([row]) => row!);

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

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

describe('SessionIdleService', () => {
  it('applies the seven-day default to an account that never chose a window', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id, minutesAgo(60 * 24 * 8));

    expect(await service().touch(account.id, target.id)).toBe('expired');
  });

  it('leaves a session inside the default window alone', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id, minutesAgo(60 * 24 * 6));

    expect(await service().touch(account.id, target.id)).toBe('active');
    expect((await readSession(target.id)).expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('expires a session idle past the chosen window', async () => {
    const account = await seedUser(db);
    await setWindow(account.id, '15m');
    const target = await seedSession(account.id, minutesAgo(16));

    expect(await service().touch(account.id, target.id)).toBe('expired');

    const { rows } = await db.drizzle.db.execute<{ now: string }>(sql`select now() as now`);
    const row = await readSession(target.id);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(new Date(rows[0]!.now).getTime());
  });

  it('keeps a session that has been idle for less than the window', async () => {
    const account = await seedUser(db);
    await setWindow(account.id, '1h');
    const target = await seedSession(account.id, minutesAgo(30));

    expect(await service().touch(account.id, target.id)).toBe('active');
    expect((await readSession(target.id)).expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves the last-used timestamp alone when it expires a session', async () => {
    const account = await seedUser(db);
    await setWindow(account.id, '15m');
    const lastUsed = minutesAgo(90);
    const target = await seedSession(account.id, minutesAgo(20));
    await db.drizzle.db
      .update(session)
      .set({ updatedAt: lastUsed })
      .where(eq(session.id, target.id));

    await service().touch(account.id, target.id);

    expect((await readSession(target.id)).updatedAt.getTime()).toBe(lastUsed.getTime());
  });

  it('starts the clock on a session that has never recorded activity', async () => {
    const account = await seedUser(db);
    await setWindow(account.id, '15m');
    const target = await seedSession(account.id, null);

    expect(await service().touch(account.id, target.id)).toBe('active');
    expect((await readSession(target.id)).lastSeenAt).not.toBeNull();
  });

  it('records the expiry as a revocation nobody performed', async () => {
    const account = await seedUser(db);
    await setWindow(account.id, '15m');
    const target = await seedSession(account.id, minutesAgo(20));
    const events = makeEventBus();

    await service(events).touch(account.id, target.id);

    expect(events.emit).toHaveBeenCalledWith(
      'identity.session.revoked',
      expect.objectContaining({ userId: account.id, sessionId: target.id }),
    );
    // No actor at all, rather than one naming the player: nobody revoked this.
    expect(events.emit).toHaveBeenCalledWith(
      'identity.session.revoked',
      expect.not.objectContaining({ actorId: expect.anything() }),
    );
  });

  it('does not rewrite the activity stamp on every request', async () => {
    const account = await seedUser(db);
    const justNow = new Date(Date.now() - 5_000);
    const target = await seedSession(account.id, justNow);

    await service().touch(account.id, target.id);

    expect((await readSession(target.id)).lastSeenAt?.getTime()).toBe(justNow.getTime());
  });
});
