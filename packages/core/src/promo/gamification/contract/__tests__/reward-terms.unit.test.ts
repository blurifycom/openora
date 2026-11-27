import { describe, expect, it } from 'vitest';
import { RankRewardTermsSchema } from '../index.js';

const terms = (over: Record<string, unknown>) => ({
  wageringMultiplier: '1',
  expiryDays: 7,
  ...over,
});

describe('RankRewardTermsSchema above-zero amounts', () => {
  it.each([
    ['0', false],
    ['0.000', false],
    ['000', false],
    ['0.000000000000000000', false],
    ['0.01', true],
    ['0.000000000000000001', true],
    ['1', true],
    ['10', true],
    ['100.0', true],
  ])('wageringMultiplier %s is accepted: %s', (wageringMultiplier, accepted) => {
    expect(RankRewardTermsSchema.safeParse(terms({ wageringMultiplier })).success).toBe(accepted);
  });

  it.each(['maxBet', 'maxWinMultiplier'] as const)('%s', (field) => {
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: null })).success).toBe(true);
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: undefined })).success).toBe(true);
    expect(RankRewardTermsSchema.safeParse(terms({})).success).toBe(true);
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: '0' })).success).toBe(false);
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: '0.000' })).success).toBe(false);
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: '0.01' })).success).toBe(true);
    expect(RankRewardTermsSchema.safeParse(terms({ [field]: '1' })).success).toBe(true);
  });

  it('rejects a negative or malformed amount before the above-zero check', () => {
    expect(RankRewardTermsSchema.safeParse(terms({ wageringMultiplier: '-1' })).success).toBe(
      false,
    );
    expect(RankRewardTermsSchema.safeParse(terms({ wageringMultiplier: '1e3' })).success).toBe(
      false,
    );
  });
});
