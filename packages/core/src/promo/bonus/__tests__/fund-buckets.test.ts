import { describe, expect, it } from 'vitest';
import { moneyCompare } from '@openora/core/server';
import {
  DEFAULT_FUND_SETTINGS,
  allowedBuckets,
  betClass,
  clampCounters,
  depositBuckets,
  isDepleted,
  splitReturn,
  sumSplit,
  wageringBase,
  type FundBucket,
  type FundSplit,
} from '../shared/fund-buckets.js';

const ALL = new Set<FundBucket>(['free', 'unlinked', 'linked', 'bonus']);
const NO_BONUS = new Set<FundBucket>(['free', 'unlinked', 'linked']);

const eq = (a: string, b: string) => moneyCompare(a, b) === 0;
const expectSplit = (actual: FundSplit | null, expected: Partial<FundSplit>) => {
  expect(actual).not.toBeNull();
  for (const bucket of ['free', 'unlinked', 'linked', 'bonus'] as const) {
    expect(eq(actual![bucket], expected[bucket] ?? '0'), `${bucket}: ${actual![bucket]}`).toBe(
      true,
    );
  }
};

describe('deposit buckets', () => {
  it('links the whole deposit when the match is under the cap', () => {
    const b = depositBuckets({
      deposit: '100',
      matchPercent: '100',
      maxGrantAmount: '500',
      decimals: 2,
    });
    expect([b.bonus, b.linked, b.unlinked].map(Number)).toEqual([100, 100, 0]);
  });

  it('links only the part the capped bonus matched', () => {
    const b = depositBuckets({
      deposit: '1000',
      matchPercent: '100',
      maxGrantAmount: '200',
      decimals: 2,
    });
    expect([b.bonus, b.linked, b.unlinked].map(Number)).toEqual([200, 200, 800]);
  });

  it('matches a 50 percent offer against twice the bonus', () => {
    const b = depositBuckets({
      deposit: '1000',
      matchPercent: '50',
      maxGrantAmount: '100',
      decimals: 2,
    });
    expect([b.bonus, b.linked, b.unlinked].map(Number)).toEqual([100, 200, 800]);
  });

  it('rounds down to the currency precision and keeps the deposit whole', () => {
    const b = depositBuckets({
      deposit: '10',
      matchPercent: '33.33',
      maxGrantAmount: '100',
      decimals: 2,
    });
    expect(Number(b.bonus)).toBe(3.33);
    expect(Number(b.linked)).toBe(9.99);
    expect(Number(b.unlinked)).toBeCloseTo(0.01);
  });

  it('sizes the rollover on the bonus or on bonus plus linked', () => {
    expect(Number(wageringBase('bonus', { bonus: '100', linked: '200' }))).toBe(100);
    expect(Number(wageringBase('bonus_plus_linked', { bonus: '100', linked: '200' }))).toBe(300);
  });
});

describe('counters over the real balance', () => {
  it('leaves counters the balance covers alone', () => {
    const c = clampCounters({ real: '500', unlinked: '100', linked: '200' });
    expect([c.unlinked, c.linked].map(Number)).toEqual([100, 200]);
  });

  it('takes a shortfall off A before B', () => {
    const c = clampCounters({ real: '250', unlinked: '100', linked: '200' });
    expect([c.unlinked, c.linked].map(Number)).toEqual([50, 200]);
    const d = clampCounters({ real: '150', unlinked: '100', linked: '200' });
    expect([d.unlinked, d.linked].map(Number)).toEqual([0, 150]);
  });
});

describe('proportional return', () => {
  it('returns a win in the shares the stake was paid', () => {
    const r = splitReturn('200', { free: '0', unlinked: '25', linked: '25', bonus: '50' });
    expectSplit(r, { unlinked: '50', linked: '50', bonus: '100' });
  });

  it('puts the rounding residue on the most restricted bucket that paid', () => {
    const paid: FundSplit = { free: '1', unlinked: '1', linked: '1', bonus: '0' };
    const r = splitReturn('1', paid);
    expect(eq(sumSplit(r), '1')).toBe(true);
    expect(moneyCompare(r.linked, r.unlinked)).toBe(1);
    expect(eq(r.unlinked, r.free)).toBe(true);
    expect(eq(r.bonus, '0')).toBe(true);
  });

  it('sends the residue to C when C paid', () => {
    const r = splitReturn('1', { free: '1', unlinked: '0', linked: '1', bonus: '1' });
    expect(eq(sumSplit(r), '1')).toBe(true);
    expect(moneyCompare(r.bonus, r.linked)).toBe(1);
  });

  it('returns everything as free money when nothing was attributed', () => {
    expectSplit(splitReturn('7', { free: '0', unlinked: '0', linked: '0', bonus: '0' }), {
      free: '7',
    });
  });
});

describe('depletion', () => {
  it('depletes below the dust threshold', () => {
    expect(isDepleted('0.009', '0.01')).toBe(true);
    expect(isDepleted('0.01', '0.01')).toBe(false);
  });

  it('depletes only at exactly zero without a threshold', () => {
    expect(isDepleted('0', '0')).toBe(true);
    expect(isDepleted('0.000000000000000001', '0')).toBe(false);
  });
});

describe('bet class', () => {
  const casino = { provider: 'aggregator', product: 'casino' } as const;

  it('is pvp for a pvp bet whatever its weight', () => {
    expect(betClass({ provider: 'aggregator', product: 'pvp' }, '100')).toBe('pvp');
  });

  it('contributes on a positive effective percent and is zero otherwise', () => {
    expect(betClass(casino, '0.000000000000000001')).toBe('contributing');
    expect(betClass(casino, '0')).toBe('zero');
  });
});

describe('allowed buckets', () => {
  const settings = {
    ...DEFAULT_FUND_SETTINGS,
    betClassBuckets: { zero: ['unlinked', 'linked'], pvp: ['unlinked'] },
  } satisfies typeof DEFAULT_FUND_SETTINGS;
  const sorted = (set: ReadonlySet<FundBucket>) => [...set].sort();

  it('allows every bucket to a class with no rule, and when no rules are set', () => {
    expect(sorted(allowedBuckets(settings, 'contributing', false))).toEqual(sorted(ALL));
    expect(sorted(allowedBuckets(DEFAULT_FUND_SETTINGS, 'pvp', false))).toEqual(sorted(ALL));
  });

  it('keeps a class to its configured buckets, free money always included', () => {
    expect(sorted(allowedBuckets(settings, 'zero', false))).toEqual(sorted(NO_BONUS));
    expect(sorted(allowedBuckets(settings, 'pvp', false))).toEqual(['free', 'unlinked']);
  });

  it('removes C on an excluded product even when the class allows it', () => {
    expect(sorted(allowedBuckets(settings, 'contributing', true))).toEqual(sorted(NO_BONUS));
  });
});
