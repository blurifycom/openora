import { describe, it, expect, vi } from 'vitest';
import type { CacheAdapter } from '@openora/core/contracts';
import { mock } from '../../testing/mock.js';
import { FunnelAnalyticsService } from '../service/funnel-analytics.service.js';

function fakeCache(get: unknown = undefined): CacheAdapter {
  return mock<CacheAdapter>({
    get: vi.fn().mockResolvedValue(get),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  });
}

describe('FunnelAnalyticsService.conversion', () => {
  it('returns nested stages with drop-off rates computed from the previous stage', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ registered: '100', email_verified: '80', first_deposit: '40', first_bet: '10' }],
    });
    const service = new FunnelAnalyticsService(mock({ db: { execute } }), fakeCache(undefined));

    const result = await service.conversion({});

    expect(result).toEqual([
      { stage: 'registered', count: 100, dropOffRate: 0 },
      { stage: 'email_verified', count: 80, dropOffRate: 0.2 },
      { stage: 'first_deposit', count: 40, dropOffRate: 0.5 },
      { stage: 'first_bet', count: 10, dropOffRate: 0.75 },
    ]);
  });

  it('never divides by zero when a stage has no members', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ registered: '0', email_verified: '0', first_deposit: '0', first_bet: '0' }],
    });
    const service = new FunnelAnalyticsService(mock({ db: { execute } }), fakeCache(undefined));

    const result = await service.conversion({});

    expect(result.every((stage) => stage.dropOffRate === 0)).toBe(true);
  });

  it('serves a repeat query from cache without querying the database', async () => {
    const cached = [{ stage: 'registered', count: 5, dropOffRate: 0 }];
    const execute = vi.fn();
    const service = new FunnelAnalyticsService(mock({ db: { execute } }), fakeCache(cached));

    const result = await service.conversion({});

    expect(result).toBe(cached);
    expect(execute).not.toHaveBeenCalled();
  });
});
