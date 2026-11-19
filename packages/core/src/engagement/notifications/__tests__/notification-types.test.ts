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
      'chat.donation.received',
      'chat.gift.claimed',
      'chat.gift.expired',
    ]) {
      expect(NotificationTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects an unknown type, the removed chat.tip.received included', () => {
    for (const type of ['chat.gift.nonsense', 'chat.tip.received']) {
      expect(NotificationTypeSchema.safeParse(type).success).toBe(false);
    }
  });
});

describe('CreateNotificationInputSchema params', () => {
  const base = { userId: randomUUID(), type: 'chat.donation.received' } as const;

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

  describe('chat.donation.received', () => {
    const params = { senderUsername: 'alice', amount: '5', currency: 'USDT' };

    it('accepts its required keys, with or without the wagering multiplier', () => {
      expect(CreateNotificationInputSchema.safeParse({ ...base, params }).success).toBe(true);
      expect(
        CreateNotificationInputSchema.safeParse({
          ...base,
          params: { ...params, wageringMultiplier: '3' },
        }).success,
      ).toBe(true);
    });
  });

  it('accepts the mention author on chat.mention and still rejects an undeclared key', () => {
    const mention = { userId: base.userId, type: 'chat.mention' } as const;
    expect(
      CreateNotificationInputSchema.safeParse({ ...mention, params: { byUsername: 'alice' } })
        .success,
    ).toBe(true);
    const result = CreateNotificationInputSchema.safeParse({
      ...mention,
      params: { byUsername: 'alice', foo: 'bar' },
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['params', 'foo']]);
  });
});
