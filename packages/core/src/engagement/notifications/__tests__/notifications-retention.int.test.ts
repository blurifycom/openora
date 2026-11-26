import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import { NotificationsService } from '../service/notifications.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDb;
let service: NotificationsService;
let created: { topic: string; payload: unknown }[];

beforeAll(async () => {
  testDb = await createTestDb([migrate]);
  created = [];
  const events: EventBus = {
    emit(topic, payload) {
      created.push({ topic, payload });
    },
    emitRaw() {},
    async emitInTransaction() {},
    on: () => () => {},
    tapTransactional() {},
  };
  service = new NotificationsService(testDb.drizzle, events);
}, 120_000);

afterAll(async () => {
  await testDb.drop();
}, 60_000);

const db = () => testDb.drizzle.db;

const ageDays = (days: number) => new Date(Date.now() - days * DAY_MS);

async function seedAged(userId: string, days: number, readAt: Date | null = null) {
  const [row] = await db()
    .insert(notification)
    .values({ userId, type: 'vip.assigned', createdAt: ageDays(days), readAt })
    .returning({ id: notification.id });
  if (!row) {
    throw new Error('seedAged: insert returned no row');
  }
  return row.id;
}

describe('notification retention', () => {
  it('purging removes only notifications older than the retention days and returns the count', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const expiredUnread = await seedAged(owner, 45);
    const expiredRead = await seedAged(other, 31, new Date());
    const withinWindow = await seedAged(owner, 29);
    const fresh = await seedAged(other, 0);
    const all = [expiredUnread, expiredRead, withinWindow, fresh];

    const result = await service.purgeExpired(30);

    expect(result).toEqual({ count: 2 });
    const remaining = await db()
      .select({ id: notification.id })
      .from(notification)
      .where(inArray(notification.id, all));
    expect(remaining.map((row) => row.id).sort()).toEqual([withinWindow, fresh].sort());
  });

  it('a notification created from a queued job twice yields one row', async () => {
    const userId = randomUUID();
    const eventId = randomUUID();
    const input = { userId, type: 'vip.assigned', eventId } as const;
    const before = created.length;

    const first = await service.createFromQueuedJob(input);
    const second = await service.createFromQueuedJob(input);

    expect(first).toEqual(expect.objectContaining({ userId, eventId }));
    expect(second).toBeNull();
    const rows = await db().select().from(notification).where(eq(notification.eventId, eventId));
    expect(rows).toHaveLength(1);
    expect(created.slice(before)).toEqual([
      {
        topic: 'notifications.created',
        payload: { notificationId: first?.id, userId },
      },
    ]);
  });
});
