import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

function makePrisma() {
  return {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    prisma = makePrisma();
    events = makeEvents();
    service = new NotificationsService(prisma as never, events as never);
  });

  it('create inserts a notification and emits an event', async () => {
    const now = new Date();
    prisma.notification.create.mockResolvedValue({
      id: 'n1',
      userId: 'u1',
      type: 'info',
      title: 'Hello',
      body: 'World',
      readAt: null,
      createdAt: now,
    });

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

  it('listForUser returns notifications ordered desc limit 50', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    await service.listForUser('u1');
    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('markRead throws NotificationNotFoundError when missing', async () => {
    prisma.notification.findUnique.mockResolvedValue(null);
    await expect(service.markRead('x', 'u1')).rejects.toBeInstanceOf(NotificationNotFoundError);
  });

  it('markRead throws NotificationOwnershipError on wrong user', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'other' });
    await expect(service.markRead('n1', 'u1')).rejects.toBeInstanceOf(NotificationOwnershipError);
  });

  it('markAllRead returns count from updateMany', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });
    const result = await service.markAllRead('u1');
    expect(result).toEqual({ count: 3 });
  });
});
