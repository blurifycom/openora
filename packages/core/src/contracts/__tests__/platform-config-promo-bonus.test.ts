import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCKED_FUNDS_MESSAGE, PromoConfigSchema } from '../schemas/platform-config.js';

describe('promo.bonus withdrawal config', () => {
  it('forfeits by default and refuses with the generic message', () => {
    const { bonus } = PromoConfigSchema.parse({});
    expect(bonus.withdrawalWhileActive).toBe('forfeit');
    expect(bonus.lockedFundsMessage).toBe(DEFAULT_LOCKED_FUNDS_MESSAGE);
  });

  it('takes the operator mode and message', () => {
    const { bonus } = PromoConfigSchema.parse({
      bonus: { withdrawalWhileActive: 'block', lockedFundsMessage: 'Finish your bonus first' },
    });
    expect(bonus).toMatchObject({
      withdrawalWhileActive: 'block',
      lockedFundsMessage: 'Finish your bonus first',
    });
  });

  it('keeps the default message when only the mode is set', () => {
    const { bonus } = PromoConfigSchema.parse({ bonus: { withdrawalWhileActive: 'block' } });
    expect(bonus.lockedFundsMessage).toBe(DEFAULT_LOCKED_FUNDS_MESSAGE);
  });

  it.each(['hold', '', 'BLOCK', null, 1])('rejects the unknown mode %j', (mode) => {
    expect(() => PromoConfigSchema.parse({ bonus: { withdrawalWhileActive: mode } })).toThrow();
  });
});
