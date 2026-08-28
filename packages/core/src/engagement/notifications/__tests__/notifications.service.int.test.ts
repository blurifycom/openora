import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

let db: TestDb;

function makeService() {
  const events = makeEventBus();
  return { svc: new NotificationsService(db.drizzle, events), events };
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
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${notification} RESTART IDENTITY CASCADE`);
});

describe('NotificationsService.create (real PG)', () => {
  it('persists an unread notification and emits created', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();

    const created = await svc.create({
      userId,
      type: 'withdrawal.approved',
      title: 'Hello',
      body: 'World',
    });

    expect(created).toMatchObject({ userId, title: 'Hello', readAt: null });
    expect(await db.drizzle.db.select().from(notification)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith('notifications.created', {
      notificationId: created!.id,
      userId,
    });
  });

  it('persists the row a social.friend_request.sent subscriber would create', async () => {
    const { svc } = makeService();
    const addresseeId = randomUUID();

    const created = await svc.create({
      userId: addresseeId,
      type: 'social.friend_request.received',
      title: 'New friend request',
      body: 'Alex sent you a friend request.',
    });

    expect(created).toMatchObject({
      userId: addresseeId,
      type: 'social.friend_request.received',
      title: 'New friend request',
      body: 'Alex sent you a friend request.',
      readAt: null,
    });
  });

  it('persists the row a social.friend_request.accepted subscriber would create', async () => {
    const { svc } = makeService();
    const requesterId = randomUUID();

    const created = await svc.create({
      userId: requesterId,
      type: 'social.friend_request.accepted',
      title: 'Friend request accepted',
      body: 'Sam accepted your friend request.',
    });

    expect(created).toMatchObject({
      userId: requesterId,
      type: 'social.friend_request.accepted',
      title: 'Friend request accepted',
      body: 'Sam accepted your friend request.',
      readAt: null,
    });
  });

  it('persists the row a wallet.bonus_rollover.completed subscriber would create', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const created = await svc.create({
      userId,
      type: 'wallet.bonus_rollover.completed',
      title: 'Bonus unlocked',
      body: 'Your 25.00 USD bonus credit has cleared its rollover requirement and is now fully withdrawable.',
    });

    expect(created).toMatchObject({
      userId,
      type: 'wallet.bonus_rollover.completed',
      title: 'Bonus unlocked',
      body: 'Your 25.00 USD bonus credit has cleared its rollover requirement and is now fully withdrawable.',
      readAt: null,
    });
  });

  it('persists the data entity-reference bag alongside the notification', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const transactionId = randomUUID();

    const created = await svc.create({
      userId,
      type: 'deposit.completed',
      title: 'Deposit completed',
      body: 'body',
      data: { transactionId },
    });

    expect(created?.data).toEqual({ transactionId });
    const [stored] = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.id, created!.id));
    expect(stored?.data).toEqual({ transactionId });
  });

  it('defaults data to null when the caller omits it', async () => {
    const { svc } = makeService();

    const created = await svc.create({
      userId: randomUUID(),
      type: 'kyc.resubmission_requested',
      title: 'Document resubmission required',
      body: 'body',
    });

    expect(created?.data).toBeNull();
  });

  it.each([
    ['deposit.completed', 'Deposit completed'],
    ['balance.adjusted', 'Balance adjusted'],
    ['withdrawal.requested', 'Withdrawal requested'],
    ['withdrawal.completed', 'Withdrawal completed'],
    ['withdrawal.failed', 'Withdrawal failed'],
    ['tip.received', 'You received a tip'],
    ['chat.mention', 'You were mentioned'],
  ] as const)(
    'persists a %s notification produced by the map-driven dispatch',
    async (type, title) => {
      const { svc } = makeService();
      const userId = randomUUID();

      const created = await svc.create({ userId, type, title, body: 'body' });

      expect(created).toMatchObject({ userId, type, title, readAt: null });
    },
  );

  it('dedupes a retried delivery of the same eventId to exactly one row, without throwing', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const eventId = randomUUID();
    const input = {
      userId,
      type: 'deposit.completed' as const,
      title: 'Deposit completed',
      body: 'body',
      eventId,
    };

    const first = await svc.create(input);
    const second = await svc.create(input);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.eventId, eventId));
    expect(rows).toHaveLength(1);
  });
});

describe('NotificationsService.listForUser (real PG)', () => {
  it('returns only the requesting player rows, newest first, with a total count', async () => {
    const { svc } = makeService();
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

    const page = await svc.listForUser({ userId, page: 1, limit: 100 });

    expect(page.items.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(page.total).toBe(2);
    expect(page).toMatchObject({ page: 1, limit: 100 });
  });

  it('returns an empty page for a player with nothing on file', async () => {
    const { svc } = makeService();

    expect(await svc.listForUser({ userId: randomUUID(), page: 1, limit: 100 })).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('paginates using page/limit and reports the full total', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await db.drizzle.db.insert(notification).values(
      Array.from({ length: 55 }, () => ({
        userId,
        type: 'withdrawal.approved' as const,
        title: 'Payout approved',
        body: 'body',
      })),
    );

    const firstPage = await svc.listForUser({ userId, page: 1, limit: 50 });
    const secondPage = await svc.listForUser({ userId, page: 2, limit: 50 });

    expect(firstPage.items).toHaveLength(50);
    expect(secondPage.items).toHaveLength(5);
    expect(firstPage.total).toBe(55);
  });
});

describe('NotificationsService.unreadCount (real PG)', () => {
  it('counts only unread rows for the requesting player', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedNotification({ userId });
    await seedNotification({ userId });
    await seedNotification({ userId, readAt: new Date() });
    await seedNotification();

    expect(await svc.unreadCount(userId)).toBe(2);
  });

  it('returns zero for a player with nothing unread', async () => {
    const { svc } = makeService();

    expect(await svc.unreadCount(randomUUID())).toBe(0);
  });
});

describe('NotificationsService.markRead (real PG)', () => {
  it('stamps readAt on the owned notification', async () => {
    const { svc } = makeService();
    const row = await seedNotification();

    const updated = await svc.markRead(row.id, row.userId);

    expect(updated.readAt).toBeInstanceOf(Date);
    const [stored] = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.id, row.id));
    expect(stored?.readAt).toBeInstanceOf(Date);
  });

  it('throws NotificationNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.markRead(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
  });

  it('refuses another players notification and leaves it unread', async () => {
    const { svc } = makeService();
    const row = await seedNotification();

    await expect(svc.markRead(row.id, randomUUID())).rejects.toBeInstanceOf(
      NotificationOwnershipError,
    );
    const [stored] = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.id, row.id));
    expect(stored?.readAt).toBeNull();
  });
});

describe('NotificationsService.markAllRead (real PG)', () => {
  it('counts only the rows it actually flipped', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedNotification({ userId });
    await seedNotification({ userId });
    await seedNotification({ userId, readAt: new Date() });

    expect(await svc.markAllRead(userId)).toEqual({ count: 2 });
  });

  it('leaves other players notifications untouched', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedNotification({ userId });
    const other = await seedNotification();

    await svc.markAllRead(userId);

    const [stored] = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.id, other.id));
    expect(stored?.readAt).toBeNull();
  });

  it('reports zero when everything is already read', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedNotification({ userId, readAt: new Date() });

    expect(await svc.markAllRead(userId)).toEqual({ count: 0 });
  });
});

describe('NotificationsService.purgeExpired (real PG)', () => {
  it('deletes only rows older than the retention window, regardless of readAt', async () => {
    const { svc } = makeService();
    const expired = await seedNotification({
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const fresh = await seedNotification({
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });

    expect(await svc.purgeExpired(30)).toEqual({ count: 1 });

    const remaining = await db.drizzle.db.select().from(notification);
    expect(remaining.map((r) => r.id)).toEqual([fresh.id]);
    expect(remaining.find((r) => r.id === expired.id)).toBeUndefined();
  });

  it('returns zero when nothing is old enough to purge', async () => {
    const { svc } = makeService();
    await seedNotification({ createdAt: new Date() });

    expect(await svc.purgeExpired(30)).toEqual({ count: 0 });
  });
});
