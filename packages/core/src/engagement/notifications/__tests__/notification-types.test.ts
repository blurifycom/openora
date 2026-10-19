import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  CreateNotificationInputSchema,
  NotificationTypeSchema,
  QueuedNotificationInputSchema,
} from '../contract/index.js';

describe('NotificationTypeSchema', () => {
  it('accepts the player-to-player transfer types', () => {
    for (const type of [
      'chat.rain.received',
      'chat.tip.received',
      'chat.gift.claimed',
      'chat.gift.expired',
    ]) {
      expect(NotificationTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects an unknown type', () => {
    expect(NotificationTypeSchema.safeParse('chat.gift.nonsense').success).toBe(false);
  });
});

describe('CreateNotificationInputSchema params', () => {
  const base = { userId: randomUUID(), type: 'chat.tip.received' } as const;

  it('accepts params carrying every required key of the type', () => {
    const params = { senderUsername: 'alice', amount: '5', currency: 'USDT' };
    expect(CreateNotificationInputSchema.safeParse({ ...base, params }).success).toBe(true);
  });

  it('rejects absent params for a type with required keys', () => {
    expect(CreateNotificationInputSchema.safeParse(base).error?.issues[0]?.path).toEqual([
      'params',
    ]);
    expect(CreateNotificationInputSchema.safeParse({ ...base, params: null }).success).toBe(false);
  });

  it('accepts absent params for a type with no required keys', () => {
    const vip = { userId: base.userId, type: 'vip.assigned' } as const;
    expect(CreateNotificationInputSchema.safeParse(vip).success).toBe(true);
  });

  it('accepts absent params only on a queued job, as the previous release queued them', () => {
    expect(QueuedNotificationInputSchema.safeParse(base).success).toBe(true);
    expect(QueuedNotificationInputSchema.safeParse({ ...base, params: null }).success).toBe(true);
  });

  it('rejects params missing a required key, naming it', () => {
    const result = CreateNotificationInputSchema.safeParse({
      ...base,
      params: { amount: '5', currency: 'USDT' },
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['params', 'senderUsername']]);
  });

  it('rejects a key the type does not declare', () => {
    const result = CreateNotificationInputSchema.safeParse({
      ...base,
      params: { senderUsername: 'alice', amount: '5', currency: 'USDT', note: 'hi' },
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['params', 'note']]);
  });
});
