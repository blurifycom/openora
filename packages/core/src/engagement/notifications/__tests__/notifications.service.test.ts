import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

let db: TestDb;

function makeService() {
  const events = { emit: vi.fn(), on: vi.fn() };
  return { svc: new NotificationsService(db.drizzle, mock<EventBus>(events)), events };
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
      notificationId: created.id,
      userId,
    });
  });
});

describe('NotificationsService.listForUser (real PG)', () => {
  it('returns only the requesting player rows, newest first', async () => {
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

    const rows = await svc.listForUser(userId);

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it('returns an empty list for a player with nothing on file', async () => {
    const { svc } = makeService();

    expect(await svc.listForUser(randomUUID())).toEqual([]);
  });

  it('caps the feed at fifty rows', async () => {
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

    expect(await svc.listForUser(userId)).toHaveLength(50);
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
