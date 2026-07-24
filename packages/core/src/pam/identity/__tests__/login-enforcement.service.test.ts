import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { LoginEnforcementService } from '../service/login-enforcement.service.js';
import type { SessionService } from '../service/session.service.js';

let db: TestDb;

function makeService() {
  const sessions = mock<SessionService>({
    revokeAllSessions: vi.fn(async () => ({ success: true as const })),
  });
  return { svc: new LoginEnforcementService(db.drizzle, sessions), sessions };
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      email: `${randomUUID()}@test.dev`,
      emailVerified: true,
      ...overrides,
    })
    .returning();
  return row!;
}

async function readUser(id: string) {
  const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, id));
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${user} RESTART IDENTITY CASCADE`);
});

describe('LoginEnforcementService (real PG)', () => {
  it('writes the RG columns and revokes every session on a timed block', async () => {
    const { svc, sessions } = makeService();
    const account = await seedUser();
    const until = new Date('2026-08-01T00:00:00.000Z');

    await svc.block(account.id, { until });

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: true, rgBlockedUntil: until });
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith(account.id);
  });

  it('stores a null expiry for an indefinite block', async () => {
    const { svc } = makeService();
    const account = await seedUser();

    await svc.block(account.id, { until: null });

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: true, rgBlockedUntil: null });
  });

  it('clears both columns on unblock without touching sessions', async () => {
    const { svc, sessions } = makeService();
    const account = await seedUser({ rgBlocked: true, rgBlockedUntil: new Date() });

    await svc.unblock(account.id);

    expect(await readUser(account.id)).toMatchObject({ rgBlocked: false, rgBlockedUntil: null });
    expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('leaves other accounts untouched', async () => {
    const { svc } = makeService();
    const blocked = await seedUser();
    const other = await seedUser();

    await svc.block(blocked.id, { until: null });

    expect(await readUser(other.id)).toMatchObject({ rgBlocked: false });
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
