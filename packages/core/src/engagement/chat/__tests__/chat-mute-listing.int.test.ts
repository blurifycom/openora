import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { AuditWritePort, RealtimeTransport } from '@openora/core/contracts';
import { mock, NO_CLIENT_META } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatMute } from '../schema/index.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';

let db: TestDb;

const ADMIN_ID = randomUUID();

const secondsFromNow = (seconds: number) => new Date(Date.now() + seconds * 1000);

const makeModeration = () =>
  new ChatModerationService(
    db.drizzle,
    mock<RealtimeTransport>({}),
    mock<AuditWritePort>({
      record: vi.fn().mockResolvedValue(undefined),
      recordInTransaction: vi.fn().mockResolvedValue(undefined),
    }),
  );

async function seedMute(overrides: Partial<typeof chatMute.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatMute)
    .values({
      userId: randomUUID(),
      roomId: null,
      scope: '__global',
      mutedBy: ADMIN_ID,
      reason: 'spam',
      ...overrides,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${chatMute} RESTART IDENTITY CASCADE`);
});

describe('ChatMuteService.listMutes expiry', () => {
  it('omits a mute whose duration has run out but keeps permanent and running ones', async () => {
    const permanent = await seedMute({ expiresAt: null });
    const running = await seedMute({ expiresAt: secondsFromNow(3600) });
    const expired = await seedMute({ expiresAt: secondsFromNow(-1) });

    const ids = (await makeModeration().listMutes()).map((m) => m.id);

    expect(ids).toContain(permanent.id);
    expect(ids).toContain(running.id);
    // The bug: enforcement already lets this player post again (assertCanSend applies the
    // same predicate), so the listing saying "muted" is the only thing disagreeing.
    expect(ids).not.toContain(expired.id);
  });

  it('omits an expired mute for the single-player listing the backoffice reads', async () => {
    const userId = randomUUID();
    await seedMute({ userId, expiresAt: secondsFromNow(-60) });

    expect(await makeModeration().listMutes(userId)).toEqual([]);
  });

  it('still omits a lifted mute that has not yet expired', async () => {
    const userId = randomUUID();
    await seedMute({ userId, expiresAt: secondsFromNow(3600), liftedAt: new Date() });

    expect(await makeModeration().listMutes(userId)).toEqual([]);
  });

  it('agrees with assertCanSend once a timed mute has lapsed', async () => {
    const moderation = makeModeration();
    const userId = randomUUID();
    await moderation.mute({
      userId,
      roomId: '__global',
      durationSeconds: 1,
      reason: 'spam',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });

    expect(await moderation.listMutes(userId)).toHaveLength(1);

    await db.drizzle.db
      .update(chatMute)
      .set({ expiresAt: secondsFromNow(-1) })
      .where(eq(chatMute.userId, userId));

    await expect(moderation.assertCanSend(userId, null)).resolves.not.toThrow();
    expect(await moderation.listMutes(userId)).toEqual([]);
  });
});
