import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  withAdvisoryXactLock,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  KYC_ADAPTER,
  KYC_STATUS_WRITER,
  type IdentityReader,
  type KycAdapter,
  type KycStatus,
  type KycStatusWriter,
  type KycTier,
  type RunContext,
} from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { kycVerification } from '../schema/index.js';
import compliancePlugin from '../plugin.js';

let db: TestDb;

const REASON = 'deposits outgrew the declared income';

const userIdByPlayerId = new Map<string, string>();
const kycStatusByUserId = new Map<string, KycStatus>();

function playerDirectory(): IdentityReader {
  return {
    ...makeIdentityReader(),
    getUserIdByPlayerId: vi.fn(async (playerId: string) => userIdByPlayerId.get(playerId) ?? null),
    getPlayerKycStatusByUserId: vi.fn(
      async (userId: string) => kycStatusByUserId.get(userId) ?? null,
    ),
  };
}

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  const events = makeEventBus();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => events);
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => playerDirectory());
  container.register(KYC_ADAPTER, () => mock<KycAdapter>({}));
  container.register(KYC_STATUS_WRITER, () =>
    mock<KycStatusWriter>({ setStatus: vi.fn(async () => null) }),
  );
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('compliance');
  compliancePlugin.register(registry);
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
  return { kernel, events };
}

const adminId = randomUUID();

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: adminId },
  catalogVersion: 'test',
  correlationId: 'kyc-agent-tools',
});

const execution = (proposalId: string = randomUUID()) => ({
  proposalId,
  actor: runContext().actor,
  correlationId: 'kyc-agent-tools',
});

async function seedPlayer(kycStatus: KycStatus = 'pending') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(player).values({ userId: randomUUID(), kycStatus }).returning(),
    new Error('seedPlayer: query returned no row'),
  );
  userIdByPlayerId.set(row.id, row.userId);
  kycStatusByUserId.set(row.userId, kycStatus);
  return row;
}

async function seedVerification(
  userId: string,
  tier: KycTier,
  status: KycStatus,
  overrides: Partial<typeof kycVerification.$inferInsert> = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(kycVerification)
      .values({
        userId,
        provider: 'vendor',
        referenceId: `ref-${randomUUID()}`,
        tier,
        status,
        documentTypes: ['passport'],
        triggeredBy: 'submission',
        ...overrides,
      })
      .returning(),
    new Error('seedVerification: query returned no row'),
  );
}

async function advancedRows(userId: string) {
  return db.drizzle.db
    .select()
    .from(kycVerification)
    .where(and(eq(kycVerification.userId, userId), eq(kycVerification.tier, 'advanced')));
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  userIdByPlayerId.clear();
  kycStatusByUserId.clear();
  await db.drizzle.db.execute(sql`TRUNCATE ${kycVerification}, ${player} RESTART IDENTITY CASCADE`);
});

describe('kyc.status through the MCP kernel (real PG)', () => {
  it('reports the normalized basic status and the current verification of each tier', async () => {
    const { kernel } = bootKernel();
    const row = await seedPlayer('verified');
    await seedVerification(row.userId, 'basic', 'rejected', { createdAt: daysAgo(3) });
    const basic = await seedVerification(row.userId, 'basic', 'verified', {
      decisionReason: 'documents match',
      decidedAt: daysAgo(1),
      createdAt: daysAgo(2),
    });
    const advanced = await seedVerification(row.userId, 'advanced', 'pending', {
      documentTypes: ['national_id'],
      riskSignals: {
        vpnOrTorDetected: true,
        dataCenterIpDetected: false,
        duplicateDeviceDetected: false,
        highRiskCountryDetected: false,
        deviceFingerprints: ['fp-1'],
      },
    });

    const result = await kernel.invokeTool('kyc.status', { playerId: row.id }, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        playerId: row.id,
        kycStatus: 'approved',
        basic: {
          status: 'approved',
          provider: 'vendor',
          documentTypes: ['passport'],
          triggeredBy: 'submission',
          decidedAt: basic.decidedAt?.toISOString(),
          createdAt: basic.createdAt.toISOString(),
        },
        advanced: {
          status: 'pending',
          provider: 'vendor',
          documentTypes: ['national_id'],
          triggeredBy: 'submission',
          decidedAt: null,
          createdAt: advanced.createdAt.toISOString(),
        },
        basicDecisionReason: 'documents match',
        advancedDecisionReason: null,
      },
    });
  });

  it('reports no verification for a player who never started one', async () => {
    const { kernel } = bootKernel();
    const row = await seedPlayer('pending');

    const result = await kernel.invokeTool('kyc.status', { playerId: row.id }, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        playerId: row.id,
        kycStatus: 'pending',
        basic: null,
        advanced: null,
        basicDecisionReason: null,
        advancedDecisionReason: null,
      },
    });
  });

  it('answers player_not_found for an unknown player', async () => {
    const { kernel } = bootKernel();

    const result = await kernel.invokeTool('kyc.status', { playerId: randomUUID() }, runContext());

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
  });
});

describe('request_enhanced_kyc through the MCP kernel (real PG)', () => {
  const precondition = (kernel: ReturnType<typeof bootKernel>['kernel'], playerId: string) =>
    kernel.checkPrecondition('request_enhanced_kyc', { playerId, reason: REASON }, runContext());

  it('passes the precondition for a player with no advanced verification in flight', async () => {
    const { kernel } = bootKernel();
    const fresh = await seedPlayer();
    const decided = await seedPlayer('approved');
    await seedVerification(decided.userId, 'advanced', 'approved', { decidedAt: daysAgo(30) });

    expect(await precondition(kernel, fresh.id)).toEqual({ ok: true });
    expect(await precondition(kernel, decided.id)).toEqual({ ok: true });
  });

  it('refuses the precondition with the code for each blocked case', async () => {
    const { kernel } = bootKernel();
    const requested = await seedPlayer();
    await seedVerification(requested.userId, 'advanced', 'resubmission_requested', {
      provider: 'manual',
      triggeredBy: 'manual',
    });
    const verifying = await seedPlayer();
    await seedVerification(verifying.userId, 'advanced', 'pending');
    const opened = await seedPlayer();
    await seedVerification(opened.userId, 'advanced', 'not_started');

    expect(await precondition(kernel, randomUUID())).toEqual({
      ok: false,
      error: 'player_not_found',
    });
    expect(await precondition(kernel, requested.id)).toEqual({
      ok: false,
      error: 'already_requested',
    });
    expect(await precondition(kernel, verifying.id)).toEqual({
      ok: false,
      error: 'verification_in_progress',
    });
    expect(await precondition(kernel, opened.id)).toEqual({
      ok: false,
      error: 'verification_in_progress',
    });
  });

  it('requests once per proposal: a replay resolves already_applied with one advanced row', async () => {
    const { kernel, events } = bootKernel();
    const row = await seedPlayer('approved');
    const proposal = execution();
    const payload = { playerId: row.id, reason: REASON };

    const first = await kernel.executeAction('request_enhanced_kyc', payload, proposal);
    const replay = await kernel.executeAction('request_enhanced_kyc', payload, proposal);

    expect(first).toEqual({ ok: true, outcome: 'applied' });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    const rows = await advancedRows(row.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'resubmission_requested',
      provider: 'manual',
      triggeredBy: 'manual',
      decisionReason: REASON,
    });
    const updates = events.emit.mock.calls.filter(([topic]) => topic === 'compliance.kyc.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toMatchObject({
      userId: row.userId,
      actorId: adminId,
      tier: 'advanced',
      status: 'resubmission_requested',
      source: 'manual',
    });
  });

  it('refuses at execution when a verification started after the proposal was checked', async () => {
    const { kernel } = bootKernel();
    const row = await seedPlayer();
    expect(await precondition(kernel, row.id)).toEqual({ ok: true });
    await seedVerification(row.userId, 'advanced', 'pending');

    const result = await kernel.executeAction(
      'request_enhanced_kyc',
      { playerId: row.id, reason: REASON },
      execution(),
    );

    expect(result).toEqual({ ok: false, error: 'verification_in_progress' });
    expect((await advancedRows(row.userId)).map((r) => r.status)).toEqual(['pending']);
  });

  it('waits for an advanced submit holding the lock, then refuses the verification it started', async () => {
    const { kernel } = bootKernel();
    const row = await seedPlayer();
    const submitLock = `kyc-submit:${row.userId}:advanced`;
    let releaseSubmit = () => {};
    const submitMayCommit = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let submitStarted = () => {};
    const submitHoldsLock = new Promise<void>((resolve) => {
      submitStarted = resolve;
    });
    const submit = db.drizzle.db.transaction((trx) =>
      withAdvisoryXactLock(trx, submitLock, async () => {
        await trx.insert(kycVerification).values({
          userId: row.userId,
          provider: 'vendor',
          referenceId: `ref-${randomUUID()}`,
          tier: 'advanced',
          status: 'pending',
          documentTypes: ['passport'],
          triggeredBy: 'submission',
        });
        submitStarted();
        await submitMayCommit;
      }),
    );
    await submitHoldsLock;

    const request = kernel.executeAction(
      'request_enhanced_kyc',
      { playerId: row.id, reason: REASON },
      execution(),
    );
    await waitForAdvisoryLockWaiter();
    releaseSubmit();
    await submit;

    expect(await request).toEqual({ ok: false, error: 'verification_in_progress' });
    expect((await advancedRows(row.userId)).map((r) => r.status)).toEqual(['pending']);
  });

  it('answers player_not_found for an unknown player', async () => {
    const { kernel } = bootKernel();

    const result = await kernel.executeAction(
      'request_enhanced_kyc',
      { playerId: randomUUID(), reason: REASON },
      execution(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
  });
});

async function waitForAdvisoryLockWaiter() {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await db.drizzle.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no transaction started waiting on the advisory lock');
}
