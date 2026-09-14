import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  queue,
  type JobQueueAdapter,
  type KycAdapter,
  type KycWebhookVerifier,
} from '@openora/core/contracts';
import {
  mock,
  makeAuditWriter,
  makeRealtimeTransport,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { createComplianceRouter } from '../router/index.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { KycVerificationService } from '../service/kyc.service.js';
import type { RgService } from '../service/rg.service.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';
import type { RgSelfServiceService } from '../service/rg-self-service.service.js';

const CTX = {
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
};
const ADMIN = '44444444-4444-4444-8444-444444444444';

const COUNTRY_RULE = {
  id: '55555555-5555-4555-8555-555555555555',
  countryCode: 'FR',
  blacklisted: true,
  redirectIp: false,
  kycRequired: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
};

const GLOBAL_KYC_CONFIG = {
  enabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
};

function fakeGuard(allowed: ReadonlyArray<`${string}:${string}`>): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource && action && !allowed.includes(`${resource}:${action}`)) {
        throw new ORPCError('FORBIDDEN', { message: `Missing permission: ${resource}:${action}` });
      }
      return { userId: ADMIN, role: 'admin' };
    }),
  });
}

function build(guard: AdminGuard) {
  const compliance = mock<ComplianceService>({
    upsertCountryRule: vi.fn(async () => COUNTRY_RULE),
    listCountryRules: vi.fn(async () => [COUNTRY_RULE]),
    getGlobalKycConfig: vi.fn(async () => GLOBAL_KYC_CONFIG),
    setGlobalKycConfig: vi.fn(async () => GLOBAL_KYC_CONFIG),
  });
  const router = createComplianceRouter({
    compliance,
    adminGuard: guard,
    audit: makeAuditWriter(),
    kyc: mock<KycVerificationService>({}),
    kycAdapter: mock<KycAdapter>({}),
    webhookVerifier: mock<KycWebhookVerifier>({}),
    jobQueue: mock<JobQueueAdapter>({}),
    kycDecisionSyncQueue: queue('kyc-decision-sync'),
    realtime: makeRealtimeTransport(),
    rg: mock<RgService>({}),
    rgMonitoring: mock<RgMonitoringService>({}),
    rgSelfService: mock<RgSelfServiceService>({}),
  });
  return { router, compliance };
}

const UPSERT_INPUT = {
  countryCode: 'FR',
  blacklisted: true,
  redirectIp: false,
  kycRequired: true,
  expectedUpdatedAt: COUNTRY_RULE.updatedAt,
};

describe('regulatory-overview router authz (mocked service)', () => {
  it('listCountryRules requires regulatory-overview:view', async () => {
    const { router } = build(fakeGuard([]));

    await expect(call(router.listCountryRules, {}, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('listCountryRules succeeds with regulatory-overview:view', async () => {
    const { router, compliance } = build(fakeGuard(['regulatory-overview:view']));

    const result = await call(router.listCountryRules, {}, { context: CTX });

    expect(result).toEqual([COUNTRY_RULE]);
    expect(compliance.listCountryRules).toHaveBeenCalled();
  });

  it('upsertCountryRule requires regulatory-overview:manage-country-rules', async () => {
    const { router } = build(fakeGuard(['regulatory-overview:view']));

    await expect(
      call(router.upsertCountryRule, UPSERT_INPUT, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('upsertCountryRule succeeds with regulatory-overview:manage-country-rules', async () => {
    const { router, compliance } = build(fakeGuard(['regulatory-overview:manage-country-rules']));

    const result = await call(router.upsertCountryRule, UPSERT_INPUT, { context: CTX });

    expect(result).toEqual(COUNTRY_RULE);
    expect(compliance.upsertCountryRule).toHaveBeenCalledWith(
      UPSERT_INPUT,
      ADMIN,
      expect.anything(),
    );
  });

  it('getGlobalKycConfig requires regulatory-overview:view', async () => {
    const { router } = build(fakeGuard([]));

    await expect(call(router.getGlobalKycConfig, {}, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('setGlobalKycConfig requires regulatory-overview:manage-global-kyc', async () => {
    const { router } = build(fakeGuard(['regulatory-overview:view']));

    await expect(
      call(
        router.setGlobalKycConfig,
        { enabled: false, confirm: true, expectedUpdatedAt: GLOBAL_KYC_CONFIG.updatedAt },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('setGlobalKycConfig succeeds with regulatory-overview:manage-global-kyc', async () => {
    const { router, compliance } = build(fakeGuard(['regulatory-overview:manage-global-kyc']));

    const result = await call(
      router.setGlobalKycConfig,
      { enabled: false, confirm: true, expectedUpdatedAt: GLOBAL_KYC_CONFIG.updatedAt },
      { context: CTX },
    );

    expect(result).toEqual(GLOBAL_KYC_CONFIG);
    expect(compliance.setGlobalKycConfig).toHaveBeenCalledWith(
      { enabled: false, confirm: true, expectedUpdatedAt: GLOBAL_KYC_CONFIG.updatedAt },
      ADMIN,
      expect.anything(),
    );
  });
});
