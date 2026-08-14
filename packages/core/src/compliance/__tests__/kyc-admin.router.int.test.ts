import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  queue,
  type JobQueueAdapter,
  type KycAdapter,
  type KycStatusWriter,
  type KycWebhookVerifier,
} from '@openora/core/contracts';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  makeIdentityReader,
  mock,
  makeEventBus,
  makeAuditWriter,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { kycVerification } from '../schema/index.js';
import { createComplianceRouter } from '../router/index.js';
import { KycVerificationService } from '../service/kyc.service.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { RgService } from '../service/rg.service.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';

const CTX = {
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
};
const ADMIN = '33333333-3333-4333-8333-333333333333';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateProfile, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${kycVerification}, ${player} RESTART IDENTITY CASCADE`);
});

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
  const events = makeEventBus();
  const statusWriter = mock<KycStatusWriter>({ setStatus: vi.fn(async () => undefined) });
  const kyc = new KycVerificationService({
    drizzle: db.drizzle,
    events,
    kycAdapter: mock<KycAdapter>({}),
    statusWriter,
    identityReader: makeIdentityReader(),
  });
  const audit = makeAuditWriter();
  const router = createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard: guard,
    audit,
    kyc,
    kycAdapter: mock<KycAdapter>({}),
    webhookVerifier: mock<KycWebhookVerifier>({}),
    jobQueue: mock<JobQueueAdapter>({}),
    kycDecisionSyncQueue: queue('kyc-decision-sync'),
    realtime: new InProcessRealtimeTransport(),
    rg: mock<RgService>({}),
    rgMonitoring: mock<RgMonitoringService>({}),
  });
  return { router, audit, statusWriter, events };
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({
      userId: randomUUID(),
      displayName: 'Player',
      currency: 'USD',
      kycStatus: 'pending',
      ...overrides,
    })
    .returning();
  return row!;
}

async function verificationsOf(userId: string) {
  return db.drizzle.db.select().from(kycVerification).where(eq(kycVerification.userId, userId));
}

describe('compliance admin KYC router authz (real PG)', () => {
  it('requestKycResubmission requires compliance:override-limit and writes no history row', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard([]));

    await expect(
      call(
        router.requestKycResubmission,
        { userId: seeded.userId, reason: 'blurry docs' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await verificationsOf(seeded.userId)).toHaveLength(0);
  });

  it('overrideKycStatus requires compliance:override-limit', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard([]));

    await expect(
      call(
        router.overrideKycStatus,
        { userId: seeded.userId, status: 'approved', reason: 'manual review' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await verificationsOf(seeded.userId)).toHaveLength(0);
  });

  it('bulkApproveKyc requires compliance:override-limit', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard([]));

    await expect(
      call(router.bulkApproveKyc, { userIds: [seeded.userId], reason: 'sweep' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await verificationsOf(seeded.userId)).toHaveLength(0);
  });
});

describe('compliance admin KYC router input validation (real PG)', () => {
  it('rejects a whitespace-only reason on requestKycResubmission before the handler runs', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard(['compliance:override-limit']));

    await expect(
      call(
        router.requestKycResubmission,
        { userId: seeded.userId, reason: '   ' },
        { context: CTX },
      ),
    ).rejects.toThrow();
    expect(await verificationsOf(seeded.userId)).toHaveLength(0);
  });

  it('rejects an empty reason on overrideKycStatus', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard(['compliance:override-limit']));

    await expect(
      call(
        router.overrideKycStatus,
        { userId: seeded.userId, status: 'rejected', reason: '' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('rejects an empty reason on bulkApproveKyc', async () => {
    const seeded = await seedPlayer();
    const { router } = build(fakeGuard(['compliance:override-limit']));

    await expect(
      call(router.bulkApproveKyc, { userIds: [seeded.userId], reason: '' }, { context: CTX }),
    ).rejects.toThrow();
  });

  it('rejects a batch over the size cap', async () => {
    const { router } = build(fakeGuard(['compliance:override-limit']));
    const userIds = Array.from({ length: 101 }, () => randomUUID());

    await expect(
      call(router.bulkApproveKyc, { userIds, reason: 'sweep' }, { context: CTX }),
    ).rejects.toThrow();
  });
});

describe('compliance admin KYC router effects (real PG)', () => {
  it('requestKycResubmission appends a manual history row and drives the status writer', async () => {
    const seeded = await seedPlayer();
    const { router, statusWriter } = build(fakeGuard(['compliance:override-limit']));

    await call(
      router.requestKycResubmission,
      { userId: seeded.userId, reason: 'blurry docs' },
      { context: CTX },
    );

    const rows = await verificationsOf(seeded.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'resubmission_requested',
      triggeredBy: 'manual',
      provider: 'manual',
      decisionReason: 'blurry docs',
    });
    expect(statusWriter.setStatus).toHaveBeenCalledWith(
      seeded.userId,
      'resubmission_requested',
      expect.objectContaining({ actorId: ADMIN, source: 'manual', reason: 'blurry docs' }),
      expect.anything(),
    );
  });

  it('overrideKycStatus writes an approved choice as manually_overridden', async () => {
    const seeded = await seedPlayer();
    const { router, statusWriter } = build(fakeGuard(['compliance:override-limit']));

    await call(
      router.overrideKycStatus,
      { userId: seeded.userId, status: 'approved', reason: 'manual review' },
      { context: CTX },
    );

    const rows = await verificationsOf(seeded.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('manually_overridden');
    expect(statusWriter.setStatus).toHaveBeenCalledWith(
      seeded.userId,
      'manually_overridden',
      expect.objectContaining({ actorId: ADMIN, source: 'manual' }),
      expect.anything(),
    );
  });

  it('is idempotent on a repeat override that resolves to the current status', async () => {
    const seeded = await seedPlayer();
    const { router, statusWriter } = build(fakeGuard(['compliance:override-limit']));
    const input = { userId: seeded.userId, status: 'approved' as const, reason: 'manual review' };

    await call(router.overrideKycStatus, input, { context: CTX });
    await db.drizzle.db
      .update(player)
      .set({ kycStatus: 'manually_overridden' })
      .where(eq(player.userId, seeded.userId));
    vi.mocked(statusWriter.setStatus).mockClear();

    await call(router.overrideKycStatus, input, { context: CTX });

    expect(await verificationsOf(seeded.userId)).toHaveLength(1);
    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('bulkApproveKyc reports per-item results and leaves history only for the real player', async () => {
    const seeded = await seedPlayer();
    const missing = randomUUID();
    const { router } = build(fakeGuard(['compliance:override-limit']));

    const result = await call(
      router.bulkApproveKyc,
      { userIds: [seeded.userId, missing], reason: 'sweep' },
      { context: CTX },
    );

    expect(result.results).toEqual(
      expect.arrayContaining([
        { userId: seeded.userId, success: true, error: null },
        { userId: missing, success: false, error: expect.any(String) },
      ]),
    );
    expect(await verificationsOf(seeded.userId)).toHaveLength(1);
    expect(await verificationsOf(missing)).toHaveLength(0);
  });

  it('audits the whole attempted bulk-approve batch, including the failed item', async () => {
    const seeded = await seedPlayer();
    const missing = randomUUID();
    const { router, audit } = build(fakeGuard(['compliance:override-limit']));

    await call(
      router.bulkApproveKyc,
      { userIds: [seeded.userId, missing], reason: 'sweep' },
      { context: CTX },
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN,
        actorType: 'admin',
        action: 'compliance.kyc.bulk_approve',
        after: expect.objectContaining({
          reason: 'sweep',
          results: expect.arrayContaining([
            { userId: seeded.userId, success: true, error: null },
            { userId: missing, success: false, error: expect.any(String) },
          ]),
        }),
      }),
    );
  });
});
