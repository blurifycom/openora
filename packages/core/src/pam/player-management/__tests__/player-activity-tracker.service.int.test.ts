import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { DrizzlePlayerActivityTracker } from '../service/player-activity-tracker.service.js';

let db: TestDb;

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function getLastSeenAt(userId: string) {
  const [row] = await db.drizzle.db
    .select({ lastSeenAt: player.lastSeenAt })
    .from(player)
    .where(eq(player.userId, userId));
  return row?.lastSeenAt ?? null;
}

beforeAll(async () => {
  db = await createTestDb([migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player} RESTART IDENTITY CASCADE`);
});

describe('DrizzlePlayerActivityTracker.touchLastSeen (real PG)', () => {
  it('writes lastSeenAt when it was previously null', async () => {
    const p = await seedPlayer();
    const tracker = new DrizzlePlayerActivityTracker(db.drizzle);

    await tracker.touchLastSeen(p.userId);

    const lastSeenAt = await getLastSeenAt(p.userId);
    expect(lastSeenAt).toBeInstanceOf(Date);
  });

  it('writes lastSeenAt when it is stale (older than 1 minute)', async () => {
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000);
    const p = await seedPlayer({ lastSeenAt: staleTimestamp });
    const tracker = new DrizzlePlayerActivityTracker(db.drizzle);

    await tracker.touchLastSeen(p.userId);

    const lastSeenAt = await getLastSeenAt(p.userId);
    expect(lastSeenAt?.getTime()).toBeGreaterThan(staleTimestamp.getTime());
  });

  it('skips the write (throttle) when lastSeenAt is recent', async () => {
    const recentTimestamp = new Date();
    const p = await seedPlayer({ lastSeenAt: recentTimestamp });
    const tracker = new DrizzlePlayerActivityTracker(db.drizzle);

    await tracker.touchLastSeen(p.userId);

    const lastSeenAt = await getLastSeenAt(p.userId);
    expect(lastSeenAt?.getTime()).toBe(recentTimestamp.getTime());
  });

  it('is a no-op for a nonexistent userId (never throws)', async () => {
    const tracker = new DrizzlePlayerActivityTracker(db.drizzle);

    await expect(tracker.touchLastSeen(randomUUID())).resolves.toBeUndefined();
  });
});
