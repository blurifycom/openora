import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call } from '@orpc/server';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  createTestRedis,
  RedisPubSubRealtimeTransport,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { makeEventBus, testContext } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import { createNotificationsRouter, notificationsChannel } from '../router/index.js';
import { NotificationsService } from '../service/notifications.service.js';
import type { Notification } from '../contract/index.js';

let db: TestDb;
let redis: TestRedis;
const transports: RedisPubSubRealtimeTransport[] = [];

function build() {
  const notifications = new NotificationsService(db.drizzle, makeEventBus());
  const realtime = new RedisPubSubRealtimeTransport(redis.client, 'notifications-test');
  transports.push(realtime);
  return { router: createNotificationsRouter({ notifications, realtime }), realtime };
}

const ctxFor = (userId: string) => testContext({ auth: { userId } });

async function nextStreamEventAfterSubscribed<T>(
  stream: AsyncGenerator<T>,
  publish: () => void,
): Promise<T> {
  const pending = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 20));
  publish();
  const { value } = await pending;
  return value;
}

async function seedNotification(overrides: Partial<typeof notification.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(notification)
    .values({
      userId: randomUUID(),
      type: 'withdrawal.approved',
      title: 'Payout approved',
      body: 'Your withdrawal is on its way.',
      ...overrides,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await Promise.allSettled(transports.splice(0).map((t) => t.close()));
  await redis.quit();
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${notification} RESTART IDENTITY CASCADE`);
});

describe('notifications router: list', () => {
  it('returns only the caller notifications, newest first, as a paginated page', async () => {
    const { router } = build();
    const userId = randomUUID();
    const older = await seedNotification({
      userId,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await seedNotification({
      userId,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await seedNotification();

    const page = await call(router.list, { page: 1, limit: 10 }, { context: ctxFor(userId) });

    expect(page.items.map((n) => n.id)).toEqual([newer.id, older.id]);
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ readAt: null });
  });

  it('round-trips the data entity-reference bag, and reports null when there is none', async () => {
    const { router } = build();
    const userId = randomUUID();
    const transactionId = randomUUID();
    await seedNotification({ userId, data: { transactionId } });
    await seedNotification({ userId, type: 'kyc.resubmission_requested', data: null });

    const page = await call(router.list, { page: 1, limit: 10 }, { context: ctxFor(userId) });

    const withData = page.items.find((n) => n.type === 'withdrawal.approved');
    const withoutData = page.items.find((n) => n.type === 'kyc.resubmission_requested');
    expect(withData?.data).toEqual({ transactionId });
    expect(withoutData?.data).toBeNull();
  });
});

describe('notifications router: unreadCount', () => {
  it('counts only the callers unread notifications', async () => {
    const { router } = build();
    const userId = randomUUID();
    await seedNotification({ userId });
    await seedNotification({ userId, readAt: new Date() });
    await seedNotification();

    const result = await call(router.unreadCount, undefined, { context: ctxFor(userId) });

    expect(result).toEqual({ count: 1 });
  });
});

describe('notifications router: markRead', () => {
  it('marks the callers own notification read', async () => {
    const { router } = build();
    const row = await seedNotification();

    const result = await call(router.markRead, { id: row.id }, { context: ctxFor(row.userId) });

    expect(result).toEqual({ success: true });
  });

  it('refuses to mark another players notification read', async () => {
    const { router } = build();
    const row = await seedNotification();

    await expect(
      call(router.markRead, { id: row.id }, { context: ctxFor(randomUUID()) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('notifications router: markAllRead', () => {
  it('flips only the callers unread rows and reports the count', async () => {
    const { router } = build();
    const userId = randomUUID();
    await seedNotification({ userId });
    await seedNotification({ userId });
    const otherUsersNotification = await seedNotification();

    const result = await call(router.markAllRead, undefined, { context: ctxFor(userId) });

    expect(result).toEqual({ count: 2 });
    const [stillUnread] = await db.drizzle.db
      .select()
      .from(notification)
      .where(sql`${notification.id} = ${otherUsersNotification.id}`);
    expect(stillUnread?.readAt).toBeNull();
  });
});

describe('notifications router: stream', () => {
  it('delivers a notification published on the callers channel', async () => {
    const { router, realtime } = build();
    const userId = randomUUID();
    const controller = new AbortController();

    const stream = await call(router.stream, undefined, {
      context: ctxFor(userId),
      signal: controller.signal,
    });

    const published: Notification = {
      id: randomUUID(),
      userId,
      type: 'deposit.completed',
      title: 'Deposit completed',
      body: 'Your deposit of 10.00 USD has been completed.',
      data: { transactionId: randomUUID() },
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    const value = await nextStreamEventAfterSubscribed(stream, () =>
      realtime.publish(notificationsChannel(userId), published),
    );
    controller.abort();

    expect(value).toEqual(published);
  });
});
