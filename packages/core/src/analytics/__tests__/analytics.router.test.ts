import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { mock, adminCaller, testContext } from '../../testing/mock.js';
import { createAnalyticsRouter } from '../router/index.js';
import type { FinancialAnalyticsService } from '../service/financial-analytics.service.js';
import type { FunnelAnalyticsService } from '../service/funnel-analytics.service.js';

const CTX = testContext();

const SUMMARY = { deposits: [], withdrawals: [], netRevenue: [], bonusCost: [] };
const GGR: never[] = [];
const FUNNEL = [{ stage: 'registered' as const, count: 0, dropOffRate: 0 }];

function fakeFinancial(): FinancialAnalyticsService {
  return mock<FinancialAnalyticsService>({
    summary: vi.fn().mockResolvedValue(SUMMARY),
    ggr: vi.fn().mockResolvedValue(GGR),
  });
}

function fakeFunnel(): FunnelAnalyticsService {
  return mock<FunnelAnalyticsService>({
    conversion: vi.fn().mockResolvedValue(FUNNEL),
  });
}

function grantingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn().mockResolvedValue(adminCaller()),
  });
}

function denyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn().mockRejectedValue(new ORPCError('FORBIDDEN', { message: 'no analytics:view' })),
  });
}

describe('analytics router authz', () => {
  it('checks the analytics:view permission before returning the financial summary', async () => {
    const guard = grantingGuard();
    const router = createAnalyticsRouter(fakeFinancial(), fakeFunnel(), guard);

    const result = await call(router.financial.summary, {}, { context: CTX });

    expect(guard.assert).toHaveBeenCalledWith(CTX, 'analytics', 'view');
    expect(result).toEqual(SUMMARY);
  });

  it('rejects the financial summary when the guard denies access', async () => {
    const router = createAnalyticsRouter(fakeFinancial(), fakeFunnel(), denyingGuard());

    await expect(call(router.financial.summary, {}, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('rejects the ggr trend when the guard denies access', async () => {
    const router = createAnalyticsRouter(fakeFinancial(), fakeFunnel(), denyingGuard());

    await expect(call(router.financial.ggr, {}, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('rejects the conversion funnel when the guard denies access', async () => {
    const router = createAnalyticsRouter(fakeFinancial(), fakeFunnel(), denyingGuard());

    await expect(call(router.funnel.conversion, {}, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('returns the conversion funnel once the guard grants access', async () => {
    const router = createAnalyticsRouter(fakeFinancial(), fakeFunnel(), grantingGuard());

    const result = await call(router.funnel.conversion, {}, { context: CTX });

    expect(result).toEqual(FUNNEL);
  });
});
