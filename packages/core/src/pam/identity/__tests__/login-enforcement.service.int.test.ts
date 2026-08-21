import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { user, session } from '../schema/index.js';
import { LoginEnforcementService } from '../service/login-enforcement.service.js';
import { SessionService } from '../service/session.service.js';

const HOUR = 3600_000;

let db: TestDb;

function makeService() {
  const events = makeEventBus();
  const sessions = new SessionService({
    drizzle: db.drizzle,
    events,
    identityReader: makeIdentityReader(),
  });
  return { svc: new LoginEnforcementService(db.drizzle, sessions), events };
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      username: `u_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
      email: `${randomUUID()}@test.dev`,
      emailVerified: true,
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedActiveSession(userId: string) {
  const [row] = await db.drizzle.db
    .insert(session)
    .values({
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 24 * HOUR),
    })
    .returning();
  return row!;
}

async function readUser(id: string) {
  const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, id));
  return row!;
}

async function activeSessionCount(userId: string) {
  const rows = await db.drizzle.db
    .select()
    .from(session)
    .where(sql`${session.userId} = ${userId} AND ${session.expiresAt} > NOW()`);
  return rows.length;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${session}, ${user} RESTART IDENTITY CASCADE`);
});

describe('LoginEnforcementService (real PG)', () => {
  it('writes the RG columns and expires every live session on a timed block', async () => {
    const { svc, events } = makeService();
    const account = await seedUser();
    await seedActiveSession(account.id);
    await seedActiveSession(account.id);
    const until = new Date('2026-08-01T00:00:00.000Z');

    await svc.block(account.id, { until });

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: true, rgBlockedUntil: until });
    expect(await activeSessionCount(account.id)).toBe(0);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.sessions.revoked_all',
      expect.objectContaining({ userId: account.id }),
    );
  });

  it('stores a null expiry for an indefinite block', async () => {
    const { svc } = makeService();
    const account = await seedUser();

    await svc.block(account.id, { until: null });

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: true, rgBlockedUntil: null });
  });

  it('leaves another account session alive when blocking one player', async () => {
    const { svc } = makeService();
    const blocked = await seedUser();
    const other = await seedUser();
    await seedActiveSession(blocked.id);
    await seedActiveSession(other.id);

    await svc.block(blocked.id, { until: null });

    expect(await activeSessionCount(other.id)).toBe(1);
    expect(await readUser(other.id)).toMatchObject({ rgBlocked: false });
  });

  it('clears both columns on unblock without reviving or revoking sessions', async () => {
    const { svc, events } = makeService();
    const account = await seedUser({ rgBlocked: true, rgBlockedUntil: new Date() });
    await seedActiveSession(account.id);

    await svc.unblock(account.id);

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: false, rgBlockedUntil: null });
    expect(await activeSessionCount(account.id)).toBe(1);
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.sessions.revoked_all',
      expect.anything(),
    );
  });

  it('overwrites an earlier block with the newer expiry', async () => {
    const { svc } = makeService();
    const account = await seedUser();
    const later = new Date('2027-01-01T00:00:00.000Z');

    await svc.block(account.id, { until: new Date('2026-01-01T00:00:00.000Z') });
    await svc.block(account.id, { until: later });

    expect(await readUser(account.id)).toMatchObject({ rgBlockedUntil: later });
  });
});
