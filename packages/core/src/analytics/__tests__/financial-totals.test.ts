import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveGgrRange,
  toBucketKey,
  totalsPerCurrency,
} from '../service/financial-analytics.service.js';

type Summary = Parameters<typeof totalsPerCurrency>[0];

const emptySummary: Summary = {
  deposits: [],
  withdrawals: [],
  netDeposits: [],
  ggr: [],
  bonusCost: [],
  sportsbookPromotionCost: [],
  ngr: [],
};

describe('totals per currency', () => {
  it('deposits across rails in one currency are summed into one total', () => {
    const totals = totalsPerCurrency({
      ...emptySummary,
      deposits: [
        { currency: 'USD', rail: 'fiat', total: '10.50' },
        { currency: 'USD', rail: 'crypto', total: '4.25' },
        { currency: 'USD', rail: null, total: '0.25' },
      ],
    });
    expect(totals).toHaveLength(1);
    expect(totals[0]?.currency).toBe('USD');
    expect(totals[0]?.deposits).toBe('15.000000000000000000');
  });

  it('two currencies produce two separate totals and are never added together', () => {
    const totals = totalsPerCurrency({
      ...emptySummary,
      deposits: [
        { currency: 'USD', rail: 'fiat', total: '100' },
        { currency: 'BTC', rail: 'crypto', total: '2' },
        { currency: 'USD', rail: 'crypto', total: '1' },
      ],
    });
    expect(totals.map((row) => [row.currency, row.deposits])).toEqual([
      ['BTC', '2.000000000000000000'],
      ['USD', '101.000000000000000000'],
    ]);
  });

  it('a currency present only in withdrawals appears with zero deposits', () => {
    const totals = totalsPerCurrency({
      ...emptySummary,
      deposits: [{ currency: 'USD', rail: 'fiat', total: '5' }],
      withdrawals: [{ currency: 'EUR', rail: 'fiat', total: '3' }],
    });
    const eur = totals.find((row) => row.currency === 'EUR');
    expect(eur?.deposits).toBe('0');
    expect(eur?.withdrawals).toBe('3.000000000000000000');
    expect(totals.find((row) => row.currency === 'USD')?.withdrawals).toBe('0');
  });

  it('a currency keeps the summary netDeposits row of that currency and never one of another', () => {
    const totals = totalsPerCurrency({
      ...emptySummary,
      deposits: [
        { currency: 'USD', rail: 'fiat', total: '10' },
        { currency: 'EUR', rail: 'fiat', total: '10' },
      ],
      withdrawals: [{ currency: 'USD', rail: 'fiat', total: '4' }],
      netDeposits: [{ currency: 'USD', total: '-6.5' }],
    });
    expect(totals.find((row) => row.currency === 'USD')?.netDeposits).toBe('-6.5');
    expect(totals.find((row) => row.currency === 'EUR')?.netDeposits).toBe('0');
  });

  it.todo('GAP: net is deposits minus withdrawals per currency');

  it('an empty summary produces no totals', () => {
    expect(totalsPerCurrency(emptySummary)).toEqual([]);
  });

  it('decimal amounts sum without floating point error', () => {
    const totals = totalsPerCurrency({
      ...emptySummary,
      deposits: [
        { currency: 'USD', rail: 'fiat', total: '0.1' },
        { currency: 'USD', rail: 'crypto', total: '0.2' },
        { currency: 'USD', rail: null, total: '0.000000000000000001' },
      ],
    });
    expect(totals[0]?.deposits).toBe('0.300000000000000001');
  });

  it('a ggr bucket key is the same for a Date and its ISO string', () => {
    const date = new Date('2026-03-15T23:59:59.999Z');
    expect(toBucketKey(date)).toBe('2026-03-15');
    expect(toBucketKey(date.toISOString())).toBe(toBucketKey(date));
  });

  describe('default window', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('an omitted date range resolves to the default window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
      const { from, to } = resolveGgrRange();
      expect(to.toISOString()).toBe('2026-03-31T12:00:00.000Z');
      expect(from.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    });

    it('an explicit range is used as given and the window is counted back from dateTo', () => {
      const explicit = resolveGgrRange('2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
      expect(explicit.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(explicit.to.toISOString()).toBe('2026-01-10T00:00:00.000Z');
      const fromOmitted = resolveGgrRange(undefined, '2026-01-31T00:00:00.000Z');
      expect(fromOmitted.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
