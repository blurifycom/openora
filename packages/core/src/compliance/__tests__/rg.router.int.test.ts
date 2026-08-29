import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  AdminUserDirectory,
  KycAdapter,
  KycWebhookVerifier,
  LoginEnforcementPort,
  SendEmailPort,
  JobQueueAdapter,
} from '@openora/core/contracts';
import { defaultResponsibleGamingConfig, queue } from '@openora/core/contracts';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
// The RG section now reports usage against each money limit, which reads the wallet and
// gaming tables through `spendFor` - the section is unreadable without them.
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import {
  makeIdentityReader,
  mock,
  makeEventBus,
  makeAdminGuard,
  makeAuditWriter,
  testContext,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgExclusion, rgFlag } from '../schema/index.js';
import { createComplianceRouter } from '../router/index.js';
import type { ComplianceService } from '../service/compliance.service.js';
import type { KycVerificationService } from '../service/kyc.service.js';
import { RgService } from '../service/rg.service.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';
import { RgSelfServiceService } from '../service/rg-self-service.service.js';

const CTX = testContext();
// A plain logged-in player: no admin permission anywhere, subject resolved from the session.
const playerCtx = (userId: string) => testContext({ auth: { userId } });
const USER = '11111111-1111-4111-8111-111111111111';
const CALLER = '33333333-3333-4333-8333-333333333333';
const HOURS = 3600_000;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateWallet, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${rgExclusion}, ${userLimit}, ${rgFlag} RESTART IDENTITY CASCADE`,
  );
});

const guardAllowing = (allow: readonly string[]) =>
  makeAdminGuard({ allow, caller: { userId: CALLER } });

function build(adminGuard: AdminGuard) {
  const events = makeEventBus();
  const enforcement = mock<LoginEnforcementPort>({
    block: vi.fn(async () => undefined),
    unblock: vi.fn(async () => undefined),
  });
  const rg = new RgService({
    drizzle: db.drizzle,
    events,
    loginEnforcement: enforcement,
    email: mock<SendEmailPort>({ send: vi.fn(async () => undefined) }),
    directory: mock<AdminUserDirectory>({ lookupPlayers: vi.fn(async () => []) }),
    identityReader: makeIdentityReader(),
  });
  const rgMonitoring = new RgMonitoringService({ drizzle: db.drizzle });
  const rgSelfService = new RgSelfServiceService({
    drizzle: db.drizzle,
    events,
    rg,
    monitoring: rgMonitoring,
    identityReader: makeIdentityReader(),
    config: defaultResponsibleGamingConfig,
  });
  const router = createComplianceRouter({
    compliance: mock<ComplianceService>({}),
    adminGuard,
    audit: makeAuditWriter(),
    kyc: mock<KycVerificationService>({}),
    kycAdapter: mock<KycAdapter>({}),
    webhookVerifier: mock<KycWebhookVerifier>({}),
    jobQueue: mock<JobQueueAdapter>({ enqueue: vi.fn(async () => ({ id: 'job-1' })) }),
    kycDecisionSyncQueue: queue('kyc-decision-sync'),
    realtime: new InProcessRealtimeTransport(),
    rg,
    rgMonitoring,
    rgSelfService,
  });
  return { router, events, enforcement };
}

async function limitsOf(userId: string) {
  return db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
}

async function exclusionsOf(userId: string) {
  return db.drizzle.db.select().from(rgExclusion).where(eq(rgExclusion.userId, userId));
}

async function seedExclusion(overrides: Partial<typeof rgExclusion.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(rgExclusion)
    .values({
      userId: USER,
      kind: 'self_exclusion',
      status: 'active',
      reason: 'gambling concern',
      isPermanent: false,
      createdBy: randomUUID(),
      ...overrides,
    })
    .returning();
  return row!;
}

describe('compliance RG router authz', () => {
  it('setPlayerLimit requires compliance:manage-rg and writes nothing when denied', async () => {
    const { router } = build(guardAllowing([]));

    await expect(
      call(
        router.setPlayerLimit,
        { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await limitsOf(USER)).toHaveLength(0);
  });

  it('activateSelfExclusion requires compliance:manage-rg and never blocks login when denied', async () => {
    const { router, enforcement } = build(guardAllowing([]));

    await expect(
      call(
        router.activateSelfExclusion,
        { userId: USER, isPermanent: true, reason: 'x', confirm: true },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(enforcement.block).not.toHaveBeenCalled();
  });

  it('liftCoolingOff requires compliance:manage-rg', async () => {
    const { router } = build(guardAllowing([]));

    await expect(
      call(router.liftCoolingOff, { userId: USER, reason: 'x' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('getRgSection requires compliance:view', async () => {
    const { router } = build(guardAllowing([]));

    await expect(
      call(router.getRgSection, { userId: USER }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('listRgFlags requires compliance:view', async () => {
    const { router } = build(guardAllowing([]));

    await expect(
      call(router.listRgFlags, { page: 1, limit: 100 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe('compliance RG router writes', () => {
  it('setPlayerLimit persists the limit against the caller as actor', async () => {
    const { router, events } = build(guardAllowing(['compliance:manage-rg']));

    const result = await call(
      router.setPlayerLimit,
      { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: CTX },
    );

    expect(Number(result.amount)).toBe(100);
    const stored = await limitsOf(USER);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.period).toBe('daily');
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({ userId: USER, actorId: CALLER }),
    );
  });

  it('activateSelfExclusion records the exclusion and blocks login', async () => {
    const { router, enforcement } = build(guardAllowing(['compliance:manage-rg']));

    await call(
      router.activateSelfExclusion,
      { userId: USER, isPermanent: true, reason: 'gambling concern', confirm: true },
      { context: CTX },
    );

    const [stored] = await exclusionsOf(USER);
    expect(stored).toMatchObject({ status: 'active', isPermanent: true });
    expect(enforcement.block).toHaveBeenCalled();
  });

  it('maps a second active exclusion to a CONFLICT error', async () => {
    await seedExclusion({ expiresAt: new Date(Date.now() + 200 * 24 * HOURS) });
    const { router } = build(guardAllowing(['compliance:manage-rg']));

    await expect(
      call(
        router.activateSelfExclusion,
        { userId: USER, isPermanent: true, reason: 'again', confirm: true },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a missing cooling-off to a NOT_FOUND error', async () => {
    const { router } = build(guardAllowing(['compliance:manage-rg']));

    await expect(
      call(router.liftCoolingOff, { userId: USER, reason: 'x' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes the caller id to liftCoolingOff when authorized', async () => {
    await seedExclusion({ kind: 'cooling_off', expiresAt: new Date(Date.now() + 24 * HOURS) });
    const { router, enforcement } = build(guardAllowing(['compliance:manage-rg']));

    await call(
      router.liftCoolingOff,
      { userId: USER, reason: 'raised in error' },
      { context: CTX },
    );

    const [stored] = await exclusionsOf(USER);
    expect(stored).toMatchObject({
      kind: 'cooling_off',
      status: 'lifted',
      liftedBy: CALLER,
      liftedReason: 'raised in error',
    });
    expect(enforcement.unblock).toHaveBeenCalledWith(USER);
  });

  it('maps a min-period lift rejection to a CONFLICT error', async () => {
    await seedExclusion({ expiresAt: new Date(Date.now() + 200 * 24 * HOURS) });
    const { router } = build(guardAllowing(['compliance:manage-rg']));

    await expect(
      call(
        router.liftSelfExclusion,
        { userId: USER, reason: 'x', confirm: true },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a lift with no exclusion on file to NOT_FOUND', async () => {
    const { router } = build(guardAllowing(['compliance:manage-rg']));

    await expect(
      call(
        router.liftSelfExclusion,
        { userId: USER, reason: 'x', confirm: true },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getRgSection reads back the limits the router just wrote', async () => {
    const { router } = build(guardAllowing(['compliance:manage-rg', 'compliance:view']));
    await call(
      router.setPlayerLimit,
      { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: CTX },
    );

    const section = await call(router.getRgSection, { userId: USER }, { context: CTX });

    expect(section.limits).toHaveLength(1);
    expect(section.limits[0]?.type).toBe('deposit');
  });

  it('getRgSection shows the compliance officer a pending player request', async () => {
    const { router } = build(guardAllowing(['compliance:view']));
    await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );
    await call(
      router.upsertLimit,
      { type: 'deposit', amount: '500', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    const section = await call(router.getRgSection, { userId: USER }, { context: CTX });

    expect(section.limits[0]).toMatchObject({
      amount: '100.00',
      pendingAmount: '500.00',
      pendingStatus: 'waiting',
    });
  });
});

// Every self-service route resolves the subject from the session. These act on the
// caller and take no userId, so the only authorization question worth asking is whether
// one player can reach another's state - and the answer has to be no.
describe('compliance router - player self-service', () => {
  const OTHER = '44444444-4444-4444-8444-444444444444';

  it('getMyRgSection returns the CALLER state, never another players', async () => {
    const { router } = build(guardAllowing([]));
    await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    const mine = await call(router.getMyRgSection, undefined, { context: playerCtx(OTHER) });

    expect(mine.limits).toHaveLength(0);
  });

  it('upsertLimit writes a first limit for the caller with no admin permission at all', async () => {
    const { router } = build(guardAllowing([]));

    const view = await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    expect(view).toMatchObject({ userId: USER, amount: '100.00', pendingStatus: null });
  });

  it('deleteLimit files a removal request and leaves the limit standing', async () => {
    const { router } = build(guardAllowing([]));
    const created = await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    const view = await call(router.deleteLimit, { id: created.id }, { context: playerCtx(USER) });

    expect(view).toMatchObject({ amount: '100.00', pendingKind: 'removal' });
    expect(await limitsOf(USER)).toHaveLength(1);
  });

  it('confirmPendingLimitChange is a CONFLICT while the cool-down runs', async () => {
    const { router } = build(guardAllowing([]));
    await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );
    const raised = await call(
      router.upsertLimit,
      { type: 'deposit', amount: '500', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    await expect(
      call(router.confirmPendingLimitChange, { id: raised.id }, { context: playerCtx(USER) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('one player cannot cancel another players request', async () => {
    const { router } = build(guardAllowing([]));
    await call(
      router.upsertLimit,
      { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );
    const raised = await call(
      router.upsertLimit,
      { type: 'deposit', amount: '500', minutes: null, period: 'daily' },
      { context: playerCtx(USER) },
    );

    await expect(
      call(router.cancelPendingLimitChange, { id: raised.id }, { context: playerCtx(OTHER) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requestCoolingOff starts a break on the caller and blocks their login', async () => {
    const { router, enforcement } = build(guardAllowing([]));

    const exclusion = await call(
      router.requestCoolingOff,
      { durationHours: 24 },
      { context: playerCtx(USER) },
    );

    expect(exclusion).toMatchObject({ userId: USER, kind: 'cooling_off' });
    expect(enforcement.block).toHaveBeenCalledWith(USER, expect.anything());
  });

  it('requestSelfExclusion is a CONFLICT when one is already active', async () => {
    const { router } = build(guardAllowing([]));
    await seedExclusion({ userId: USER, kind: 'self_exclusion', isPermanent: true });

    await expect(
      call(
        router.requestSelfExclusion,
        { isPermanent: true, confirm: true },
        { context: playerCtx(USER) },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
