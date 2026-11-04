import { describe, it, expect } from 'vitest';
import { SetStreakConfigInputSchema, StreakConfigSchema } from '../contract/index.js';

const rate = (day: number) => ({ day, unrankedRatePercent: '1', rankedUpliftPercent: '5' });
const reward = (day: number) => ({
  day,
  amount: '5',
  rolloverMultiplier: '10',
  claimExpiryDays: 7,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  dailyMinWager: '10',
  eligibleProducts: ['casino'],
  rakebackMilestones: [rate(1), rate(7)],
  fixedRewards: [reward(3), reward(35)],
  ...overrides,
});

const issuePaths = (input: unknown) => {
  const result = SetStreakConfigInputSchema.safeParse(input);
  return result.success ? null : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('setting the streak config', () => {
  it('accepts a valid config, including the boundary days 1 and 35', () => {
    expect(SetStreakConfigInputSchema.safeParse(config()).success).toBe(true);
  });

  it('accepts empty lists, which is a streak that pays nothing', () => {
    expect(
      SetStreakConfigInputSchema.safeParse(config({ rakebackMilestones: [], fixedRewards: [] }))
        .success,
    ).toBe(true);
  });

  it.each([0, 36, -1, 1.5])('rejects a milestone on day %s, naming the day field', (day) => {
    expect(issuePaths(config({ rakebackMilestones: [rate(day)] }))).toEqual([
      'rakebackMilestones.0.day',
    ]);
    expect(issuePaths(config({ fixedRewards: [reward(day)] }))).toEqual(['fixedRewards.0.day']);
  });

  it('rejects days that are not ascending, naming the offending entry', () => {
    expect(issuePaths(config({ rakebackMilestones: [rate(5), rate(2)] }))).toEqual([
      'rakebackMilestones.1.day',
    ]);
  });

  it('rejects two entries on the same day, naming the later one', () => {
    expect(issuePaths(config({ fixedRewards: [reward(3), reward(3)] }))).toEqual([
      'fixedRewards.1.day',
    ]);
  });

  it('rejects more than 35 rows in a list', () => {
    const rows = Array.from({ length: 36 }, (_, index) => rate(index + 1));
    expect(issuePaths(config({ rakebackMilestones: rows }))).toContain('rakebackMilestones');
  });

  it.each([
    ['a zero amount', { amount: '0' }, 'fixedRewards.0.amount'],
    ['a zero amount with decimals', { amount: '0.000' }, 'fixedRewards.0.amount'],
    ['a negative amount', { amount: '-1' }, 'fixedRewards.0.amount'],
    ['a zero rollover', { rolloverMultiplier: '0' }, 'fixedRewards.0.rolloverMultiplier'],
    [
      'a rollover above the bonus engine limit',
      { rolloverMultiplier: '1000.01' },
      'fixedRewards.0.rolloverMultiplier',
    ],
    ['a zero claim expiry', { claimExpiryDays: 0 }, 'fixedRewards.0.claimExpiryDays'],
    ['a claim expiry above a year', { claimExpiryDays: 366 }, 'fixedRewards.0.claimExpiryDays'],
    ['a fractional claim expiry', { claimExpiryDays: 1.5 }, 'fixedRewards.0.claimExpiryDays'],
    ['a zero max bet', { maxBet: '0' }, 'fixedRewards.0.maxBet'],
    ['a negative max bet', { maxBet: '-1' }, 'fixedRewards.0.maxBet'],
  ])('rejects %s, naming its field', (_label, patch, path) => {
    expect(issuePaths(config({ fixedRewards: [{ ...reward(3), ...patch }] }))).toEqual([path]);
  });

  it('accepts a max bet above zero, and none', () => {
    expect(
      SetStreakConfigInputSchema.safeParse(
        config({
          fixedRewards: [
            { ...reward(3), maxBet: '2.5' },
            { ...reward(4), maxBet: null },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts a rollover of exactly the limit', () => {
    expect(
      SetStreakConfigInputSchema.safeParse(
        config({ fixedRewards: [{ ...reward(3), rolloverMultiplier: '1000' }] }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['a negative rate', { unrankedRatePercent: '-1' }, 'rakebackMilestones.0.unrankedRatePercent'],
    [
      'a rate above 100',
      { unrankedRatePercent: '100.01' },
      'rakebackMilestones.0.unrankedRatePercent',
    ],
    [
      'a negative uplift',
      { rankedUpliftPercent: '-5' },
      'rakebackMilestones.0.rankedUpliftPercent',
    ],
  ])('rejects %s, naming its field', (_label, patch, path) => {
    expect(issuePaths(config({ rakebackMilestones: [{ ...rate(1), ...patch }] }))).toEqual([path]);
  });

  it('accepts a zero rate, which switches a milestone off without deleting it', () => {
    expect(
      SetStreakConfigInputSchema.safeParse(
        config({
          rakebackMilestones: [{ day: 1, unrankedRatePercent: '0', rankedUpliftPercent: '0' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects a zero daily minimum, naming the field', () => {
    expect(issuePaths(config({ dailyMinWager: '0' }))).toEqual(['dailyMinWager']);
  });

  it('rejects a config without the enabled switch', () => {
    expect(issuePaths({ ...config(), enabled: undefined })).toEqual(['enabled']);
  });
});

describe('a malformed decimal string', () => {
  it.each(['1,000', 'abc', '1e3', ' 5', '', '1.5.5', '-1'])(
    'reports the rollover %j as a field error instead of throwing',
    (rolloverMultiplier) => {
      const paths = issuePaths(config({ fixedRewards: [{ ...reward(3), rolloverMultiplier }] }));
      expect([...new Set(paths)]).toEqual(['fixedRewards.0.rolloverMultiplier']);
    },
  );

  it.each(['NaN', 'Infinity', '1e2', ' 5', '', '1,5', 'abc', '1.234', '1000'])(
    'reports the rate %j as a field error instead of throwing',
    (value) => {
      expect(
        issuePaths(config({ rakebackMilestones: [{ ...rate(1), unrankedRatePercent: value }] })),
      ).toEqual(['rakebackMilestones.0.unrankedRatePercent']);
      expect(
        issuePaths(config({ rakebackMilestones: [{ ...rate(1), rankedUpliftPercent: value }] })),
      ).toEqual(['rakebackMilestones.0.rankedUpliftPercent']);
    },
  );
});

describe('reading a streak config that has no dollar threshold yet', () => {
  it('reads a zero daily minimum, which a config converted from another currency carries', () => {
    expect(StreakConfigSchema.safeParse(config({ dailyMinWager: '0' })).success).toBe(true);
  });

  it('refuses to save it back until a threshold above zero is entered', () => {
    expect(issuePaths(config({ dailyMinWager: '0.000000000000000000', enabled: true }))).toEqual([
      'dailyMinWager',
    ]);
  });

  it.each([
    ['no product', []],
    ['a repeated product', ['casino', 'casino']],
    ['an unknown product', ['slots']],
  ])('rejects a product list with %s', (_, eligibleProducts) => {
    const result = SetStreakConfigInputSchema.safeParse(config({ eligibleProducts }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.slice(0, 1)).toEqual(['eligibleProducts']);
  });
});
