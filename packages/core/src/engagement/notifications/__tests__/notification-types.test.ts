import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CreateNotificationInputSchema, NotificationTypeSchema } from '../contract/index.js';

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

  it('accepts absent params, as a dispatch job queued before params existed carries', () => {
    expect(CreateNotificationInputSchema.safeParse(base).success).toBe(true);
    expect(CreateNotificationInputSchema.safeParse({ ...base, params: null }).success).toBe(true);
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
