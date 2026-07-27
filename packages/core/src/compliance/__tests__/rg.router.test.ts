import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { KycAdapter, KycWebhookVerifier } from '@openora/core/contracts';
import { mock, adminCaller, testContext } from '../../testing/mock.js';
import { createComplianceRouter } from '../router/index.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { KycVerificationService } from '../service/kyc.service.js';
import {
  RgService,
  ExclusionPeriodNotElapsedError,
  ExclusionNotFoundError,
} from '../service/rg.service.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';

const CTX = testContext();
const USER = '11111111-1111-4111-8111-111111111111';

function fakeGuard(allowed: ReadonlyArray<`${string}:${string}`>): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource && action && !allowed.includes(`${resource}:${action}`)) {
        throw new ORPCError('FORBIDDEN', { message: `Missing permission: ${resource}:${action}` });
      }
      return adminCaller();
    }),
  });
}

function build(
  guard: AdminGuard,
  rg: Partial<RgService> = {},
  monitoring: Partial<RgMonitoringService> = {},
) {
  return createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard: guard,
    kyc: mock<KycVerificationService>({}),
    kycAdapter: mock<KycAdapter>({}),
    webhookVerifier: mock<KycWebhookVerifier>({}),
    rg: mock<RgService>(rg),
    rgMonitoring: mock<RgMonitoringService>(monitoring),
  });
}

describe('compliance RG router authz', () => {
  it('setPlayerLimit requires compliance:manage-rg', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(
        router.setPlayerLimit,
        { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('activateSelfExclusion requires compliance:manage-rg', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(
        router.activateSelfExclusion,
        { userId: USER, isPermanent: true, reason: 'x', confirm: true },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('getRgSection requires compliance:view', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(router.getRgSection, { userId: USER }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('listRgFlags requires compliance:view', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(router.listRgFlags, { page: 1, limit: 100 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('passes the caller id to setPlayerLimit when authorized', async () => {
    const setPlayerLimit = vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      userId: USER,
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
      createdAt: new Date().toISOString(),
    });
    const router = build(fakeGuard(['compliance:manage-rg']), { setPlayerLimit });
    await call(
      router.setPlayerLimit,
      { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: CTX },
    );
    expect(setPlayerLimit).toHaveBeenCalledWith(USER, expect.any(Object), 'admin-1', {
      ip: null,
      userAgent: null,
    });
  });

  it('liftCoolingOff requires compliance:manage-rg', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(router.liftCoolingOff, { userId: USER, reason: 'x' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('maps a missing cooling-off to a NOT_FOUND error', async () => {
    const liftCoolingOff = vi.fn().mockRejectedValue(new ExclusionNotFoundError(USER));
    const router = build(fakeGuard(['compliance:manage-rg']), { liftCoolingOff });
    await expect(
      call(router.liftCoolingOff, { userId: USER, reason: 'x' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes the caller id to liftCoolingOff when authorized', async () => {
    const now = new Date().toISOString();
    const liftCoolingOff = vi.fn().mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      userId: USER,
      kind: 'cooling_off',
      status: 'lifted',
      reason: 'support request',
      isPermanent: false,
      startsAt: now,
      expiresAt: now,
      liftedAt: now,
      liftedReason: 'raised in error',
      liftedBy: '44444444-4444-4444-8444-444444444444',
      createdBy: '44444444-4444-4444-8444-444444444444',
      createdAt: now,
      updatedAt: now,
    });
    const router = build(fakeGuard(['compliance:manage-rg']), { liftCoolingOff });
    await call(
      router.liftCoolingOff,
      { userId: USER, reason: 'raised in error' },
      { context: CTX },
    );
    expect(liftCoolingOff).toHaveBeenCalledWith(USER, expect.any(Object), 'admin-1', {
      ip: null,
      userAgent: null,
    });
  });

  it('maps a min-period lift rejection to a CONFLICT error', async () => {
    const liftSelfExclusion = vi.fn().mockRejectedValue(new ExclusionPeriodNotElapsedError());
    const router = build(fakeGuard(['compliance:manage-rg']), { liftSelfExclusion });
    await expect(
      call(
        router.liftSelfExclusion,
        { userId: USER, reason: 'x', confirm: true },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
