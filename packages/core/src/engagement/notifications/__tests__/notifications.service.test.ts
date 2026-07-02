import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../../../testing/mock.js';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

function chain(result: unknown): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(result);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function makeDrizzle(r: { select?: unknown; insert?: unknown; update?: unknown } = {}) {
  const db = {
    select: vi.fn(() => chain(r.select ?? [])),
    insert: vi.fn(() => chain(r.insert ?? [])),
    update: vi.fn(() => chain(r.update ?? [])),
  };
  return mockDb(db);
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('NotificationsService', () => {
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    events = makeEvents();
  });

  it('create inserts a notification and emits an event', async () => {
    const now = new Date();
    const drizzle = makeDrizzle({
      insert: [
        {
          id: 'n1',
          userId: 'u1',
          type: 'info',
          title: 'Hello',
          body: 'World',
          readAt: null,
          createdAt: now,
        },
      ],
    });
    const service = new NotificationsService(drizzle as never, events as never);

    const result = await service.create({
      userId: 'u1',
      type: 'info',
      title: 'Hello',
      body: 'World',
    });

    expect(result.id).toBe('n1');
    expect(events.emit).toHaveBeenCalledWith('notifications.created', {
      notificationId: 'n1',
      userId: 'u1',
    });
  });

  it('listForUser returns notifications from the db', async () => {
    const rows = [{ id: 'n1', userId: 'u1' }];
    const drizzle = makeDrizzle({ select: rows });
    const service = new NotificationsService(drizzle as never, events as never);
    const result = await service.listForUser('u1');
    expect(result).toEqual(rows);
  });

  it('markRead throws NotificationNotFoundError when missing', async () => {
    const drizzle = makeDrizzle({ select: [] });
    const service = new NotificationsService(drizzle as never, events as never);
    await expect(service.markRead('x', 'u1')).rejects.toBeInstanceOf(NotificationNotFoundError);
  });

  it('markRead throws NotificationOwnershipError on wrong user', async () => {
    const drizzle = makeDrizzle({ select: [{ id: 'n1', userId: 'other' }] });
    const service = new NotificationsService(drizzle as never, events as never);
    await expect(service.markRead('n1', 'u1')).rejects.toBeInstanceOf(NotificationOwnershipError);
  });

  it('markAllRead returns count from the number of updated rows', async () => {
    const drizzle = makeDrizzle({ update: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const service = new NotificationsService(drizzle as never, events as never);
    const result = await service.markAllRead('u1');
    expect(result).toEqual({ count: 3 });
  });
});
