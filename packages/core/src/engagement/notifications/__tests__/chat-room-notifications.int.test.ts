import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { asc, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import { CreateNotificationInputSchema } from '../contract/index.js';
import { bootPluginHarness } from '../../../testing/plugin-harness.js';
import notificationsPlugin from '../plugin.js';

let db: TestDb;

const bootPlugin = () => bootPluginHarness(notificationsPlugin, db, { runEnqueuedJobs: true });

function readNotifications() {
  return db.drizzle.db.select().from(notification).orderBy(asc(notification.createdAt));
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${notification} RESTART IDENTITY CASCADE`);
});

describe('notifications plugin - chat room ownership (real PG)', () => {
  it('notifies the inheriting owner, and nobody else', async () => {
    const { fire } = bootPlugin();
    const roomId = randomUUID();
    const newOwnerId = randomUUID();

    await fire('chat.room.ownership.transferred', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId: randomUUID(),
      newOwnerId,
      reason: 'account-closed',
    });

    const rows = await readNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: newOwnerId,
      type: 'chat.room.ownership_transferred',
      params: { roomName: 'Wheel Spin' },
      data: { roomId },
    });
  });

  it('notifies every member of a room on the countdown except the closed owner', async () => {
    const { fire } = bootPlugin();
    const roomId = randomUUID();
    const previousOwnerId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()];

    await fire('chat.room.scheduled_for_deletion', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [previousOwnerId, ...memberIds],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    });

    const rows = await readNotifications();
    expect(rows.map((r) => r.userId).sort()).toEqual([...memberIds].sort());
    expect(rows[0]).toMatchObject({
      type: 'chat.room.scheduled_for_deletion',
      params: { roomName: 'Wheel Spin' },
      data: { roomId },
    });
  });

  it('produces exactly one notification for a room whose only other member is closed', async () => {
    const { fire } = bootPlugin();
    const previousOwnerId = randomUUID();
    const activeId = randomUUID();

    await fire('chat.room.scheduled_for_deletion', {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [activeId],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    });

    const rows = await readNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: activeId, type: 'chat.room.scheduled_for_deletion' });
  });

  it('keys the fan-out per member, so a redelivered event notifies nobody twice', async () => {
    const { fire, enqueued } = bootPlugin();
    const previousOwnerId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()];
    const payload = {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [previousOwnerId, ...memberIds],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    };

    const eventId = await fire('chat.room.scheduled_for_deletion', payload);
    expect(new Set(enqueued.map((e) => e.opts?.idempotencyKey)).size).toBe(memberIds.length);
    for (const userId of memberIds) {
      expect(enqueued.map((e) => e.opts?.idempotencyKey)).toContain(
        `notifications-dispatch:${eventId}:${userId}`,
      );
    }

    await fire('chat.room.scheduled_for_deletion', payload, eventId);

    const rows = await readNotifications();
    expect(rows).toHaveLength(memberIds.length);
  });

  it('queues dispatch jobs the previous release, which requires title and body, can still run', async () => {
    const { fire, enqueued } = bootPlugin();
    const previousOwnerId = randomUUID();
    const previousReleaseJob = z.object({
      input: z.object({ title: z.string(), body: z.string() }),
    });
    const currentJob = z.object({ input: CreateNotificationInputSchema });

    await fire('chat.room.ownership.transferred', {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      newOwnerId: randomUUID(),
      reason: 'account-closed',
    });
    await fire('chat.room.scheduled_for_deletion', {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [randomUUID()],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    });

    expect(enqueued).toHaveLength(2);
    for (const { payload } of enqueued) {
      expect(previousReleaseJob.safeParse(payload).success).toBe(true);
      expect(currentJob.safeParse(payload).success).toBe(true);
    }
  });
});
