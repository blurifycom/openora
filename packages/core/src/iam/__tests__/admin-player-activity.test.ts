import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { user, session } from '@openora/core/pam/schema/identity';
import { DrizzleAdminPlayerActivity } from '../adapters/admin-player-activity.js';

let db: TestDb;
let activity: DrizzleAdminPlayerActivity;

const AT = (iso: string) => new Date(iso);

async function seedUser(createdAt: Date) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name: 'U', email: `${randomUUID()}@x.dev`, createdAt })
    .returning();
  return row!;
}

async function seedSession(userId: string, updatedAt: Date) {
  await db.drizzle.db.insert(session).values({
    userId,
    token: randomUUID(),
    expiresAt: new Date(updatedAt.getTime() + 24 * 60 * 60 * 1000),
    createdAt: updatedAt,
    updatedAt,
  });
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity]);
  activity = new DrizzleAdminPlayerActivity(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${session}, ${user} RESTART IDENTITY CASCADE`);
});

describe('DrizzleAdminPlayerActivity.getRegistrationsOverTime (real PG)', () => {
  it('counts registrations per day and includes zero-registration days', async () => {
    await seedUser(AT('2026-01-01T10:00:00.000Z'));
    await seedUser(AT('2026-01-01T15:00:00.000Z'));
    await seedUser(AT('2026-01-03T00:00:00.000Z'));

    const rows = await activity.getRegistrationsOverTime({
      dateFrom: AT('2026-01-01T00:00:00.000Z'),
      dateTo: AT('2026-01-03T00:00:00.000Z'),
    });

    expect(rows).toEqual([
      { date: '2026-01-01', registrations: 2 },
      { date: '2026-01-02', registrations: 0 },
      { date: '2026-01-03', registrations: 1 },
    ]);
  });
});

describe('DrizzleAdminPlayerActivity.getActiveUsersTrend (real PG)', () => {
  it('computes distinct DAU/WAU/MAU per day from session activity', async () => {
    const alice = await seedUser(AT('2025-11-01T00:00:00.000Z'));
    const bob = await seedUser(AT('2025-11-01T00:00:00.000Z'));
    // Alice active on the target day; Bob active 5 days earlier (inside WAU/MAU, outside DAU).
    await seedSession(alice.id, AT('2026-01-10T12:00:00.000Z'));
    await seedSession(bob.id, AT('2026-01-05T12:00:00.000Z'));

    const rows = await activity.getActiveUsersTrend({
      dateFrom: AT('2026-01-10T00:00:00.000Z'),
      dateTo: AT('2026-01-10T00:00:00.000Z'),
    });

    expect(rows).toEqual([{ date: '2026-01-10', dau: 1, wau: 2, mau: 2 }]);
  });

  it('excludes a session outside every window from all three counts', async () => {
    const alice = await seedUser(AT('2025-11-01T00:00:00.000Z'));
    await seedSession(alice.id, AT('2025-12-01T00:00:00.000Z'));

    const rows = await activity.getActiveUsersTrend({
      dateFrom: AT('2026-01-10T00:00:00.000Z'),
      dateTo: AT('2026-01-10T00:00:00.000Z'),
    });

    expect(rows).toEqual([{ date: '2026-01-10', dau: 0, wau: 0, mau: 0 }]);
  });

  it('counts a user with two sessions on the same day only once', async () => {
    const alice = await seedUser(AT('2025-11-01T00:00:00.000Z'));
    await seedSession(alice.id, AT('2026-01-10T08:00:00.000Z'));
    await seedSession(alice.id, AT('2026-01-10T18:00:00.000Z'));

    const rows = await activity.getActiveUsersTrend({
      dateFrom: AT('2026-01-10T00:00:00.000Z'),
      dateTo: AT('2026-01-10T00:00:00.000Z'),
    });

    expect(rows).toEqual([{ date: '2026-01-10', dau: 1, wau: 1, mau: 1 }]);
  });
});

describe('DrizzleAdminPlayerActivity.getRetentionCohorts (real PG)', () => {
  it('does not count the registration-day session itself as a return', async () => {
    const alice = await seedUser(AT('2026-01-01T10:00:00.000Z'));
    // Only session is the one created at registration - should NOT count as returned.
    await seedSession(alice.id, AT('2026-01-01T10:00:00.000Z'));

    const rows = await activity.getRetentionCohorts(
      { dateFrom: AT('2026-01-01T00:00:00.000Z'), dateTo: AT('2026-01-02T00:00:00.000Z') },
      7,
    );

    expect(rows).toEqual([
      { cohortDate: '2026-01-01', cohortSize: 1, returned: 0, returnRate: 0, isComplete: true },
    ]);
  });

  it('counts a session on the day after registration as returned', async () => {
    const alice = await seedUser(AT('2026-01-01T10:00:00.000Z'));
    await seedSession(alice.id, AT('2026-01-02T10:00:00.000Z'));

    const rows = await activity.getRetentionCohorts(
      { dateFrom: AT('2026-01-01T00:00:00.000Z'), dateTo: AT('2026-01-02T00:00:00.000Z') },
      7,
    );

    expect(rows[0]).toMatchObject({ cohortSize: 1, returned: 1, returnRate: 1 });
  });

  it('excludes a session after the retention window from the count', async () => {
    const alice = await seedUser(AT('2026-01-01T10:00:00.000Z'));
    await seedSession(alice.id, AT('2026-01-10T10:00:00.000Z'));

    const rows = await activity.getRetentionCohorts(
      { dateFrom: AT('2026-01-01T00:00:00.000Z'), dateTo: AT('2026-01-02T00:00:00.000Z') },
      7,
    );

    expect(rows[0]).toMatchObject({ cohortSize: 1, returned: 0, returnRate: 0 });
  });

  it('flags an incomplete cohort whose window has not elapsed yet', async () => {
    const now = new Date();
    await seedUser(now);

    const rows = await activity.getRetentionCohorts({ dateFrom: now, dateTo: now }, 30);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.isComplete).toBe(false);
  });

  it('has no rows when nobody registered in the requested range', async () => {
    const rows = await activity.getRetentionCohorts(
      { dateFrom: AT('2026-01-01T00:00:00.000Z'), dateTo: AT('2026-01-01T00:00:00.000Z') },
      30,
    );

    expect(rows).toEqual([]);
  });
});
