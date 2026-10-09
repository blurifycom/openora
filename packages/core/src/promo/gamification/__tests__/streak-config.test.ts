import { describe, it, expect } from 'vitest';
import { SetStreakConfigInputSchema } from '../contract/index.js';

const config = (resetAfterDay: number) => ({
  currency: 'USD',
  dailyMinWager: '10',
  eligibleProducts: ['casino'],
  milestones: [
    {
      day: 3,
      rewards: [{ kind: 'bonus', amount: '5', terms: { wageringMultiplier: '1', expiryDays: 30 } }],
    },
  ],
  resetAfterDay,
});

describe('setting the streak config', () => {
  it('accepts a milestone on or before the day the run resets', () => {
    expect(SetStreakConfigInputSchema.safeParse(config(3)).success).toBe(true);
  });

  it('rejects a milestone after the day the run resets, which no player could reach', () => {
    const result = SetStreakConfigInputSchema.safeParse(config(2));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['milestones']);
  });
});
