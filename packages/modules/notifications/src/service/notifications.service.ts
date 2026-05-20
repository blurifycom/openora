import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import type { CreateNotificationInput } from '../schemas/index.js';

export class NotificationNotFoundError extends Error {
  constructor(id: string) {
    super(`Notification not found: ${id}`);
    this.name = 'NotificationNotFoundError';
  }
}

export class NotificationOwnershipError extends Error {
  constructor(id: string) {
    super(`Notification ${id} does not belong to the requesting user`);
    this.name = 'NotificationOwnershipError';
  }
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async create(input: CreateNotificationInput) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
      },
    });
    this.events.emit('notifications.created', {
      notificationId: notification.id,
      userId: input.userId,
    });
    return notification;
  }

  async listForUser(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id } });
    if (!notification) {
      throw new NotificationNotFoundError(id);
    }
    if (notification.userId !== userId) {
      throw new NotificationOwnershipError(id);
    }
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  }
}
