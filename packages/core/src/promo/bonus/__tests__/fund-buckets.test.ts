import { describe, expect, it } from 'vitest';
import { BONUS_GRANT_SOURCES } from '@openora/core/contracts';
import { moneyCompare } from '@openora/core/server';
import {
  clampCounters,
  depositBuckets,
  grantLocks,
  isDepleted,
  splitLocked,
  splitReturn,
  splitStake,
  sumSplit,
  wageringBase,
  type FundSplit,
} from '../shared/fund-buckets.js';

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

describe('spend order', () => {
  const available: FundSplit = { free: '50', unlinked: '30', linked: '20', bonus: '100' };

  it('spends free, then A, B, C when free funds go first', () => {
    expectSplit(splitStake({ stake: '120', available, order: 'first', bonusAllowed: true }), {
      free: '50',
      unlinked: '30',
      linked: '20',
      bonus: '20',
    });
  });

  it('spends A, B, C, then free when free funds go last', () => {
    expectSplit(splitStake({ stake: '160', available, order: 'last', bonusAllowed: true }), {
      unlinked: '30',
      linked: '20',
      bonus: '100',
      free: '10',
    });
  });

  it('skips C on a product bonus funds cannot pay for', () => {
    expectSplit(splitStake({ stake: '60', available, order: 'last', bonusAllowed: false }), {
      unlinked: '30',
      linked: '20',
      free: '10',
    });
  });

  it('refuses a stake the buckets together cannot cover', () => {
    expect(splitStake({ stake: '201', available, order: 'first', bonusAllowed: true })).toBeNull();
    expect(splitStake({ stake: '101', available, order: 'first', bonusAllowed: false })).toBeNull();
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

describe('splitLocked', () => {
  const grant = (unlinked: string, linked: string) => ({ unlinked, linked });

  it('locks A and B of every grant and frees the rest', () => {
    const r = splitLocked('150', [grant('100', '0'), grant('0', '20')]);
    expect(eq(r.locked, '120')).toBe(true);
    expect(eq(r.free, '30')).toBe(true);
  });

  it('frees everything with no grants', () => {
    const r = splitLocked('42.5', []);
    expect(eq(r.locked, '0')).toBe(true);
    expect(eq(r.free, '42.5')).toBe(true);
  });

  it('never locks more than the real balance holds', () => {
    const r = splitLocked('50', [grant('40', '30')]);
    expect(eq(r.locked, '50')).toBe(true);
    expect(eq(r.free, '0')).toBe(true);
  });

  it('locks nothing on an empty balance', () => {
    const r = splitLocked('0', [grant('10', '10')]);
    expect(eq(r.locked, '0')).toBe(true);
    expect(eq(r.free, '0')).toBe(true);
  });

  it('keeps 18-decimal precision', () => {
    const r = splitLocked('1', [grant('0.000000000000000001', '0')]);
    expect(eq(r.free, '0.999999999999999999')).toBe(true);
  });
});

describe('grantLocks', () => {
  it('locks a deposit grant by default and nothing else', () => {
    expect(grantLocks('deposit', {})).toBe(true);
    for (const source of BONUS_GRANT_SOURCES.filter((s) => s !== 'deposit')) {
      expect(grantLocks(source, {}), source).toBe(false);
    }
  });

  it('follows the terms when they say', () => {
    expect(grantLocks('deposit', { funds: { lockWithdrawals: false } })).toBe(false);
    expect(grantLocks('manual', { funds: { lockWithdrawals: true } })).toBe(true);
  });
});
