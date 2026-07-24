import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  queue,
  type AuditWritePort,
  type JobQueueAdapter,
  type KycAdapter,
  type KycWebhookVerifier,
} from '@openora/core/contracts';
import { mock, NO_CLIENT_META } from '../../testing/mock.js';
import { createComplianceRouter } from '../router/index.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { KycVerificationService } from '../service/kyc.service.js';
import type { RgService } from '../service/rg.service.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';

const CTX = {
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
};
const USER = '11111111-1111-4111-8111-111111111111';

function fakeGuard(allowed: ReadonlyArray<`${string}:${string}`>): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource && action && !allowed.includes(`${resource}:${action}`)) {
        throw new ORPCError('FORBIDDEN', { message: `Missing permission: ${resource}:${action}` });
      }
      return { userId: 'admin-1', role: 'admin' };
    }),
  });
}

function fullKycRow(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: '22222222-2222-4222-8222-222222222222',
    userId: USER,
    provider: 'manual',
    referenceId: 'manual-1',
    status: 'resubmission_requested',
    documentTypes: [],
    decisionReason: null,
    riskSignals: null,
    checks: null,
    triggeredBy: 'manual',
    submittedAt: now,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function build(
  guard: AdminGuard,
  kyc: Partial<KycVerificationService> = {},
  audit: AuditWritePort = mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
) {
  return createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard: guard,
    audit,
    kyc: mock<KycVerificationService>(kyc),
    kycAdapter: mock<KycAdapter>({}),
    webhookVerifier: mock<KycWebhookVerifier>({}),
    jobQueue: mock<JobQueueAdapter>({}),
    kycDecisionSyncQueue: queue('kyc-decision-sync'),
    rg: mock<RgService>({}),
    rgMonitoring: mock<RgMonitoringService>({}),
  });
}

describe('compliance admin KYC router authz', () => {
  it('requestKycResubmission requires compliance:override-limit', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(
        router.requestKycResubmission,
        { userId: USER, reason: 'blurry docs' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('overrideKycStatus requires compliance:override-limit', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(
        router.overrideKycStatus,
        { userId: USER, status: 'approved', reason: 'manual review' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('bulkApproveKyc requires compliance:override-limit', async () => {
    const router = build(fakeGuard([]));
    await expect(
      call(router.bulkApproveKyc, { userIds: [USER], reason: 'sweep' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects an empty/whitespace reason on requestKycResubmission before the handler runs', async () => {
    const router = build(fakeGuard(['compliance:override-limit']));
    await expect(
      call(router.requestKycResubmission, { userId: USER, reason: '   ' }, { context: CTX }),
    ).rejects.toThrow();
  });

  it('rejects an empty reason on overrideKycStatus', async () => {
    const router = build(fakeGuard(['compliance:override-limit']));
    await expect(
      call(
        router.overrideKycStatus,
        { userId: USER, status: 'rejected', reason: '' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('rejects an empty reason on bulkApproveKyc', async () => {
    const router = build(fakeGuard(['compliance:override-limit']));
    await expect(
      call(router.bulkApproveKyc, { userIds: [USER], reason: '' }, { context: CTX }),
    ).rejects.toThrow();
  });

  it('bulkApproveKyc rejects a batch over the size cap', async () => {
    const router = build(fakeGuard(['compliance:override-limit']));
    const userIds = Array.from({ length: 101 }, (_, i) => USER.replace(/1$/, String(i % 10)));
    await expect(
      call(router.bulkApproveKyc, { userIds, reason: 'sweep' }, { context: CTX }),
    ).rejects.toThrow();
  });

  it('passes the caller id + input through to requestResubmission when authorized', async () => {
    const requestResubmission = vi.fn().mockResolvedValue(fullKycRow());
    const router = build(fakeGuard(['compliance:override-limit']), { requestResubmission });
    await call(
      router.requestKycResubmission,
      { userId: USER, reason: 'blurry docs' },
      { context: CTX },
    );
    expect(requestResubmission).toHaveBeenCalledWith(USER, 'blurry docs', 'admin-1');
  });

  it('passes the caller id + input through to overrideStatus when authorized', async () => {
    const overrideStatus = vi.fn().mockResolvedValue(fullKycRow({ status: 'manually_overridden' }));
    const router = build(fakeGuard(['compliance:override-limit']), { overrideStatus });
    await call(
      router.overrideKycStatus,
      { userId: USER, status: 'approved', reason: 'manual review' },
      { context: CTX },
    );
    expect(overrideStatus).toHaveBeenCalledWith(USER, 'approved', 'manual review', 'admin-1');
  });

  it('wraps bulkApprove results under a results key', async () => {
    const bulkApprove = vi.fn().mockResolvedValue([{ userId: USER, success: true, error: null }]);
    const router = build(fakeGuard(['compliance:override-limit']), { bulkApprove });
    const result = await call(
      router.bulkApproveKyc,
      { userIds: [USER], reason: 'sweep' },
      { context: CTX },
    );
    expect(bulkApprove).toHaveBeenCalledWith([USER], 'sweep', 'admin-1');
    expect(result).toEqual({ results: [{ userId: USER, success: true, error: null }] });
  });

  it('audits the whole attempted bulk-approve batch, including a failed/not-found item', async () => {
    const missingUser = '99999999-9999-4999-8999-999999999999';
    const results = [
      { userId: USER, success: true, error: null },
      { userId: missingUser, success: false, error: 'Failed to approve KYC' },
    ];
    const bulkApprove = vi.fn().mockResolvedValue(results);
    const record = vi.fn().mockResolvedValue(undefined);
    const audit = mock<AuditWritePort>({ record });
    const router = build(fakeGuard(['compliance:override-limit']), { bulkApprove }, audit);

    await call(
      router.bulkApproveKyc,
      { userIds: [USER, missingUser], reason: 'sweep' },
      { context: CTX },
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        actorType: 'admin',
        action: 'compliance.kyc.bulk_approve',
        after: { reason: 'sweep', results },
      }),
    );
  });
});
