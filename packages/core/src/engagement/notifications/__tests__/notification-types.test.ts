import { describe, it, expect } from 'vitest';
import { NotificationTypeSchema } from '../contract/index.js';

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
