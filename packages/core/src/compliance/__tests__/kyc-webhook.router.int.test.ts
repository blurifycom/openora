import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { BullMqJobQueue } from '@openora/core/server';
import {
  queue,
  type KycAdapter,
  type KycWebhookVerifier,
  type QueueName,
} from '@openora/core/contracts';
import {
  createTestRedis,
  RedisPubSubRealtimeTransport,
  redisUrlForWorker,
  type TestRedis,
} from '@openora/core/testing';
import {
  mock,
  makeAuditWriter,
  makeRealtimeTransport,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import {
  createComplianceRouter,
  createKycStatusStream,
  kycStatusChannel,
} from '../router/index.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { KycVerificationService } from '../service/kyc.service.js';
import type { RgService } from '../service/rg.service.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';
import type { RgSelfServiceService } from '../service/rg-self-service.service.js';

const KYC_DECISION_SYNC_QUEUE = queue('kyc-decision-sync');

let redis: TestRedis;
const instances: BullMqJobQueue[] = [];
const rawQueues: Queue[] = [];

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await Promise.allSettled(instances.map((q) => q.close()));
  await Promise.allSettled(rawQueues.map((q) => q.close()));
  instances.length = 0;
  rawQueues.length = 0;
  await redis.flush();
});

afterAll(async () => {
  await redis.quit();
});

function makeJobQueue(): BullMqJobQueue {
  const q = new BullMqJobQueue(redisUrlForWorker());
  instances.push(q);
  return q;
}

function rawQueue(name: QueueName): Queue {
  const q = new Queue(name, {
    connection: { url: redisUrlForWorker(), maxRetriesPerRequest: null },
  });
  rawQueues.push(q);
  return q;
}

async function enqueuedJobs() {
  const jobs = await rawQueue(KYC_DECISION_SYNC_QUEUE).getJobs(['waiting', 'delayed', 'active']);
  return jobs.map((j) => ({ id: j.id, data: j.data as Record<string, unknown>, opts: j.opts }));
}

function build(opts: {
  webhookVerifier: KycWebhookVerifier;
  kycAdapter: KycAdapter;
  jobQueue: BullMqJobQueue;
}) {
  return createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard: mock<AdminGuard>({}),
    audit: makeAuditWriter(),
    kyc: mock<KycVerificationService>({}),
    kycAdapter: opts.kycAdapter,
    webhookVerifier: opts.webhookVerifier,
    jobQueue: opts.jobQueue,
    kycDecisionSyncQueue: KYC_DECISION_SYNC_QUEUE,
    realtime: makeRealtimeTransport(),
    rg: mock<RgService>({}),
    rgMonitoring: mock<RgMonitoringService>({}),
    rgSelfService: mock<RgSelfServiceService>({}),
  });
}

function ctx(rawBody: string | undefined, headers: Record<string, string> = {}) {
  return { context: { rawBody, request: { headers }, clientMeta: NO_CLIENT_META } };
}

function bodyHashKey(rawBody: string): string {
  return `kyc-decision-sync:${createHash('sha256').update(rawBody).digest('hex')}`;
}

const acceptingVerifier = () => mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) });

const REDIS_SUBSCRIBE_SETTLE_MS = 200;

describe('compliance streamKycStatus router', () => {
  it('streams only player-safe updates from the player channel', async () => {
    const realtime = new RedisPubSubRealtimeTransport(redis.client, 'kyc-webhook-test');
    try {
      const iterator = createKycStatusStream(realtime, 'user-1', undefined)[Symbol.asyncIterator]();
      const next = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, REDIS_SUBSCRIBE_SETTLE_MS));

      await realtime.publish(kycStatusChannel('other-user'), {
        eventId: '11111111-1111-4111-8111-111111111111',
        status: 'rejected',
        tier: 'basic',
      });
      const callerUpdate = {
        eventId: '22222222-2222-4222-8222-222222222222',
        status: 'approved',
        tier: 'advanced',
      };
      await realtime.publish(kycStatusChannel('user-1'), callerUpdate);

      await expect(next).resolves.toEqual({ done: false, value: callerUpdate });
      await iterator.return?.(undefined);
    } finally {
      await realtime.close();
    }
  });
});

describe('compliance kycWebhook router (real Redis-backed JOB_QUEUE)', () => {
  it('acks 2xx and enqueues a kyc-decision-sync job without calling the vendor', async () => {
    const getStatus = vi.fn();
    const kycAdapter = mock<KycAdapter>({
      parseWebhook: vi.fn().mockReturnValue({ referenceId: 'ref-1', status: 'approved' }),
      getStatus,
    });
    const router = build({
      webhookVerifier: acceptingVerifier(),
      kycAdapter,
      jobQueue: makeJobQueue(),
    });

    const rawBody = '{"referenceId":"ref-1"}';
    const result = await call(router.kycWebhook, {}, ctx(rawBody));

    expect(result).toEqual({ ok: true });
    expect(getStatus).not.toHaveBeenCalled();
    const jobs = await enqueuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({
      payload: { referenceId: 'ref-1', status: 'approved', receivedAt: expect.any(String) },
      meta: expect.objectContaining({ idempotencyKey: bodyHashKey(rawBody) }),
    });
    expect(jobs[0]?.opts).toMatchObject({
      attempts: expect.any(Number),
      backoff: expect.any(Object),
    });
  });

  it('dedupes a byte-identical redelivery but keeps a later decision on the same reference+status (reject -> approve -> reject)', async () => {
    const kycAdapter = mock<KycAdapter>({
      parseWebhook: vi.fn((rawBody: string) => {
        const parsed = JSON.parse(rawBody) as { status: 'approved' | 'rejected' };
        return { referenceId: 'ref-1', status: parsed.status };
      }),
    });
    const router = build({
      webhookVerifier: acceptingVerifier(),
      kycAdapter,
      jobQueue: makeJobQueue(),
    });

    const firstReject = JSON.stringify({ status: 'rejected', nonce: 'evt-1' });
    const approved = JSON.stringify({ status: 'approved', nonce: 'evt-2' });
    const secondReject = JSON.stringify({ status: 'rejected', nonce: 'evt-3' });

    await call(router.kycWebhook, {}, ctx(firstReject));
    await call(router.kycWebhook, {}, ctx(firstReject));
    await call(router.kycWebhook, {}, ctx(approved));
    await call(router.kycWebhook, {}, ctx(secondReject));

    const jobs = await enqueuedJobs();
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(3);
    expect(jobs.map((j) => (j.data.payload as { status: string }).status).sort()).toEqual([
      'approved',
      'rejected',
      'rejected',
    ]);
  });

  it('rejects an invalid signature and enqueues nothing', async () => {
    const router = build({
      webhookVerifier: mock<KycWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) }),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn() }),
      jobQueue: makeJobQueue(),
    });

    await expect(
      call(router.kycWebhook, {}, ctx('{"referenceId":"ref-1"}', { 'x-kyc-signature': 'bad' })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await enqueuedJobs()).toHaveLength(0);
  });

  it('rejects a missing raw body (never falls back to an empty body) and enqueues nothing', async () => {
    const router = build({
      webhookVerifier: acceptingVerifier(),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn() }),
      jobQueue: makeJobQueue(),
    });

    await expect(call(router.kycWebhook, {}, ctx(undefined))).rejects.toBeInstanceOf(ORPCError);
    expect(await enqueuedJobs()).toHaveLength(0);
  });

  it('does not enqueue when the adapter cannot parse the webhook into a decision', async () => {
    const router = build({
      webhookVerifier: acceptingVerifier(),
      kycAdapter: mock<KycAdapter>({ parseWebhook: vi.fn().mockReturnValue(null) }),
      jobQueue: makeJobQueue(),
    });

    const result = await call(router.kycWebhook, {}, ctx('not a decision'));

    expect(result).toEqual({ ok: true });
    expect(await enqueuedJobs()).toHaveLength(0);
  });
});
