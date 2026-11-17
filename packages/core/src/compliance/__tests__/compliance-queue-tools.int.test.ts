import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  KYC_ADAPTER,
  KYC_STATUS_WRITER,
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
import { kycVerification, rgFlag } from '../schema/index.js';
import compliancePlugin from '../plugin.js';

let db: TestDb;

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const DECISION_REASON = 'name on the ID does not match the account';

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(KYC_ADAPTER, () => mock<KycAdapter>({}));
  container.register(KYC_STATUS_WRITER, () =>
    mock<KycStatusWriter>({ setStatus: vi.fn(async () => null) }),
  );
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('compliance');
  compliancePlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'compliance-queue-tools',
});

async function seedPlayer() {
  return findOneOrThrow(
    await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning(),
    new Error('seedPlayer: query returned no row'),
  );
}

async function seedFlag(values: Partial<typeof rgFlag.$inferInsert> & { userId: string }) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(rgFlag)
      .values({
        flagType: 'limit_threshold',
        limitType: 'deposit',
        detail: { trigger: 'free text that must stay out', kind: 'self_exclusion' },
        ...values,
      })
      .returning(),
    new Error('seedFlag: query returned no row'),
  );
}

async function seedVerification(userId: string, tier: KycTier, status: KycStatus, createdAt: Date) {
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
        decisionReason: DECISION_REASON,
        triggeredBy: 'submission',
        submittedAt: createdAt,
        createdAt,
      })
      .returning(),
    new Error('seedVerification: query returned no row'),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${rgFlag}, ${kycVerification}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('rg.flags_queue through the MCP kernel (real PG)', () => {
  it('counts the active flags by type and lists the oldest by player id, with no flag detail', async () => {
    const kernel = bootKernel();
    const [oldest, newer] = [await seedPlayer(), await seedPlayer()];
    const first = await seedFlag({ userId: oldest.userId, flaggedAt: hoursAgo(30) });
    const second = await seedFlag({
      userId: newer.userId,
      flagType: 'session_time',
      limitType: null,
      flaggedAt: hoursAgo(2),
    });
    await seedFlag({ userId: newer.userId, status: 'cleared', flaggedAt: hoursAgo(400) });

    const result = await kernel.invokeTool('rg.flags_queue', { limit: 5 }, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        activeCount: 2,
        activeByType: [
          { flagType: 'limit_threshold', count: 1 },
          { flagType: 'session_time', count: 1 },
        ],
        flaggedLast7Days: 2,
        oldest: [
          {
            flagId: first.id,
            playerId: oldest.id,
            flagType: 'limit_threshold',
            limitType: 'deposit',
            flaggedAt: first.flaggedAt.toISOString(),
            waitHours: expect.closeTo(30, 0),
          },
          {
            flagId: second.id,
            playerId: newer.id,
            flagType: 'session_time',
            limitType: null,
            flaggedAt: second.flaggedAt.toISOString(),
            waitHours: expect.closeTo(2, 0),
          },
        ],
      },
    });
    const served = JSON.stringify(result);
    expect(served).not.toContain('free text');
    expect(served).not.toContain(oldest.userId);
  });

  it('narrows the oldest to one flag type, and refuses a limit out of bounds', async () => {
    const kernel = bootKernel();
    const row = await seedPlayer();
    await seedFlag({ userId: row.userId, flaggedAt: hoursAgo(10) });
    const session = await seedFlag({
      userId: row.userId,
      flagType: 'session_time',
      limitType: null,
      flaggedAt: hoursAgo(5),
    });

    const narrowed = await kernel.invokeTool(
      'rg.flags_queue',
      { flagType: 'session_time' },
      runContext(),
    );
    expect(narrowed).toMatchObject({ ok: true, output: { activeCount: 2 } });
    expect(narrowed).toMatchObject({ ok: true, output: { oldest: [{ flagId: session.id }] } });

    expect(await kernel.invokeTool('rg.flags_queue', { limit: 21 }, runContext())).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });
});

describe('kyc.queue through the MCP kernel (real PG)', () => {
  it("counts each player's latest verification per tier and lists the oldest pending ones", async () => {
    const kernel = bootKernel();
    const [superseded, waiting, resubmitting] = [
      await seedPlayer(),
      await seedPlayer(),
      await seedPlayer(),
    ];
    // An older pending attempt the player's later verification superseded waits for nothing.
    await seedVerification(superseded.userId, 'basic', 'pending', hoursAgo(100));
    await seedVerification(superseded.userId, 'basic', 'approved', hoursAgo(50));
    const advanced = await seedVerification(waiting.userId, 'advanced', 'pending', hoursAgo(20));
    const basic = await seedVerification(waiting.userId, 'basic', 'pending', hoursAgo(10));
    await seedVerification(resubmitting.userId, 'basic', 'resubmission_requested', hoursAgo(5));

    const result = await kernel.invokeTool('kyc.queue', {}, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        pendingCount: 2,
        resubmissionRequestedCount: 1,
        byTier: [
          { tier: 'basic', pending: 1, resubmissionRequested: 1 },
          { tier: 'advanced', pending: 1, resubmissionRequested: 0 },
        ],
        avgPendingWaitHours: expect.closeTo(15, 0),
        oldest: [
          {
            verificationId: advanced.id,
            playerId: waiting.id,
            tier: 'advanced',
            status: 'pending',
            triggeredBy: 'submission',
            documentTypes: ['passport'],
            submittedAt: advanced.submittedAt.toISOString(),
            waitHours: expect.closeTo(20, 0),
          },
          expect.objectContaining({ verificationId: basic.id, tier: 'basic' }),
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(DECISION_REASON);
  });

  it('narrows the oldest pending to one tier', async () => {
    const kernel = bootKernel();
    const row = await seedPlayer();
    await seedVerification(row.userId, 'advanced', 'pending', hoursAgo(20));
    const basic = await seedVerification(row.userId, 'basic', 'pending', hoursAgo(10));

    const result = await kernel.invokeTool('kyc.queue', { tier: 'basic', limit: 1 }, runContext());

    expect(result).toMatchObject({ ok: true, output: { oldest: [{ verificationId: basic.id }] } });
    expect(result).toMatchObject({ ok: true, output: { pendingCount: 2 } });
  });
});
