import { describe, it, expect, vi } from 'vitest';
import type { CacheAdapter } from '@openora/core/contracts';
import { mock, makeDrizzle } from '../../testing/mock.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';

function fakeCache(get: unknown = undefined): CacheAdapter {
  return mock<CacheAdapter>({
    get: vi.fn().mockResolvedValue(get),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  });
}

describe('FinancialAnalyticsService.summary', () => {
  it('splits deposits and withdrawals by currency and rail and computes net revenue and bonus cost', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          { currency: 'USD', rail: 'fiat', total: '500.00' },
          { currency: 'EUR', rail: null, total: '75.00' },
        ],
        [{ currency: 'USD', rail: 'crypto', total: '120.00' }],
        [
          { currency: 'USD', netRevenue: '350.00', bonusCost: '30.00' },
          { currency: 'EUR', netRevenue: '75.00', bonusCost: '0' },
        ],
      ],
    });
    const service = new FinancialAnalyticsService(drizzle, fakeCache());

    const result = await service.summary({ currency: undefined });

    expect(result.deposits).toEqual([
      { currency: 'USD', rail: 'fiat', total: '500.00' },
      { currency: 'EUR', rail: null, total: '75.00' },
    ]);
    expect(result.withdrawals).toEqual([{ currency: 'USD', rail: 'crypto', total: '120.00' }]);
    expect(result.netRevenue).toEqual([
      { currency: 'USD', total: '350.00' },
      { currency: 'EUR', total: '75.00' },
    ]);
    expect(result.bonusCost).toEqual([
      { currency: 'USD', total: '30.00' },
      { currency: 'EUR', total: '0' },
    ]);
  });

  it('serves a repeat query from cache without touching the database', async () => {
    const cached = { deposits: [], withdrawals: [], netRevenue: [], bonusCost: [] };
    const cache = fakeCache(cached);
    const drizzle = makeDrizzle();
    const service = new FinancialAnalyticsService(drizzle, cache);

    const result = await service.summary({});

    expect(result).toBe(cached);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('FinancialAnalyticsService.ggr', () => {
  it('groups zero-filled buckets into one series per currency', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { currency: 'USD', bucket: new Date('2026-01-01T00:00:00.000Z'), ggr: '10.00' },
        { currency: 'USD', bucket: new Date('2026-01-02T00:00:00.000Z'), ggr: '0' },
        { currency: 'EUR', bucket: new Date('2026-01-01T00:00:00.000Z'), ggr: '-5.00' },
      ],
    });
    const service = new FinancialAnalyticsService(mock({ db: { execute } }), fakeCache(undefined));

    const result = await service.ggr({
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-01-02T00:00:00.000Z',
      granularity: 'day',
    });

    expect(result).toEqual([
      {
        currency: 'USD',
        points: [
          { bucket: '2026-01-01', ggr: '10.00' },
          { bucket: '2026-01-02', ggr: '0' },
        ],
      },
      { currency: 'EUR', points: [{ bucket: '2026-01-01', ggr: '-5.00' }] },
    ]);
  });

  it('handles a bucket returned as a raw timestamp string instead of a Date', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ currency: 'USD', bucket: '2026-01-01 00:00:00+00', ggr: '10.00' }],
    });
    const service = new FinancialAnalyticsService(mock({ db: { execute } }), fakeCache(undefined));

    const result = await service.ggr({ granularity: 'day' });

    expect(result).toEqual([{ currency: 'USD', points: [{ bucket: '2026-01-01', ggr: '10.00' }] }]);
  });
});
