import { createHash } from 'node:crypto';
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

const KYC_DECISION_SYNC_QUEUE = queue('kyc-decision-sync');

function build(opts: {
  webhookVerifier: KycWebhookVerifier;
  kycAdapter: KycAdapter;
  jobQueue: JobQueueAdapter;
}) {
  return createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard: mock<AdminGuard>({}),
    audit: mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
    kyc: mock<KycVerificationService>({}),
    kycAdapter: opts.kycAdapter,
    webhookVerifier: opts.webhookVerifier,
    jobQueue: opts.jobQueue,
    kycDecisionSyncQueue: KYC_DECISION_SYNC_QUEUE,
    rg: mock<RgService>({}),
    rgMonitoring: mock<RgMonitoringService>({}),
  });
}

function ctx(rawBody: string | undefined, headers: Record<string, string> = {}) {
  return { context: { rawBody, request: { headers }, clientMeta: NO_CLIENT_META } };
}

function bodyHashKey(rawBody: string): string {
  return `kyc-decision-sync:${createHash('sha256').update(rawBody).digest('hex')}`;
}

describe('compliance kycWebhook router', () => {
  it('acks 2xx and enqueues a kyc-decision-sync job without calling the vendor', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'job-1' });
    const kycAdapter = mock<KycAdapter>({
      parseWebhook: vi.fn().mockReturnValue({ referenceId: 'ref-1', status: 'approved' }),
    });
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) }),
      kycAdapter,
      jobQueue: mock<JobQueueAdapter>({ enqueue }),
    });

    const rawBody = '{"referenceId":"ref-1"}';
    const result = await call(router.kycWebhook, {}, ctx(rawBody));

    expect(result).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledWith(
      KYC_DECISION_SYNC_QUEUE,
      { referenceId: 'ref-1', status: 'approved', receivedAt: expect.any(String) },
      expect.objectContaining({
        idempotencyKey: bodyHashKey(rawBody),
        orderingKey: 'ref-1',
        attempts: expect.any(Number),
        backoff: expect.any(Object),
      }),
    );
  });

  it('dedupes a byte-identical redelivery but issues a fresh key for a later decision on the same reference+status (reject -> approve -> reject)', async () => {
    const kycAdapter = mock<KycAdapter>({
      parseWebhook: vi.fn((rawBody: string) => {
        const parsed = JSON.parse(rawBody) as { status: 'approved' | 'rejected'; nonce: string };
        return { referenceId: 'ref-1', status: parsed.status };
      }),
    });
    const enqueue = vi.fn().mockResolvedValue({ id: 'job-1' });
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) }),
      kycAdapter,
      jobQueue: mock<JobQueueAdapter>({ enqueue }),
    });

    const firstRejectBody = JSON.stringify({ status: 'rejected', nonce: 'evt-1' });
    const redeliveredRejectBody = firstRejectBody; // byte-identical retry
    const approvedBody = JSON.stringify({ status: 'approved', nonce: 'evt-2' });
    const secondRejectBody = JSON.stringify({ status: 'rejected', nonce: 'evt-3' });

    await call(router.kycWebhook, {}, ctx(firstRejectBody));
    await call(router.kycWebhook, {}, ctx(redeliveredRejectBody));
    await call(router.kycWebhook, {}, ctx(approvedBody));
    await call(router.kycWebhook, {}, ctx(secondRejectBody));

    const keys = enqueue.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    // The redelivered reject shares its key with the first (true duplicate, collapses);
    // the later reject - though the SAME status as the first - gets its own fresh key,
    // since it is a genuinely different decision, never silently dropped.
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it('rejects an invalid signature and enqueues nothing', async () => {
    const enqueue = vi.fn();
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) }),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn() }),
      jobQueue: mock<JobQueueAdapter>({ enqueue }),
    });

    await expect(
      call(router.kycWebhook, {}, ctx('{"referenceId":"ref-1"}', { 'x-kyc-signature': 'bad' })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a missing raw body (never falls back to an empty body) and enqueues nothing', async () => {
    const enqueue = vi.fn();
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) }),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn() }),
      jobQueue: mock<JobQueueAdapter>({ enqueue }),
    });

    await expect(call(router.kycWebhook, {}, ctx(undefined))).rejects.toBeInstanceOf(ORPCError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue when the adapter cannot parse the webhook into a decision', async () => {
    const enqueue = vi.fn();
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) }),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn().mockReturnValue(null) }),
      jobQueue: mock<JobQueueAdapter>({ enqueue }),
    });

    const result = await call(router.kycWebhook, {}, ctx('not a decision'));

    expect(result).toEqual({ ok: true });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
