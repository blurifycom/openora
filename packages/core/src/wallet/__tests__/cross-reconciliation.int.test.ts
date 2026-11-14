import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { eventOutbox, findOneOrThrow } from '@openora/core/server';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import type {
  DeadLetters,
  PlatformConfig,
  PlayEligibilitySnapshot,
  RgLimitsSnapshot,
  WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeAuditWriter,
  makeEventBus,
  makeExchangeRateReader,
  makeIdentityReader,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  ledgerApiRequest,
  ledgerPlayEligibility,
  ledgerUserLimit,
  ledgerUserLimitVersion,
  wallet,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';
import { LedgerPlayEligibilityService } from '../service/ledger-play-eligibility.service.js';
import { LedgerRgLimitsService } from '../service/ledger-rg-limits.service.js';
import {
  ReconciliationService,
  projectionDriftCheck,
  type ReconciliationServiceDeps,
} from '../service/reconciliation.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateServer, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletJobRun}, ${walletReconciliationFinding}, ${wallet},
      ${ledgerApiRequest}, ${ledgerPlayEligibility}, ${ledgerUserLimit}, ${ledgerUserLimitVersion},
      ${eventOutbox} RESTART IDENTITY CASCADE`,
  );
});

const PROVIDER = 'studio';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function makeReconciliation(
  extra: Pick<ReconciliationServiceDeps, 'projectionChecks' | 'broker'> = {},
) {
  const audit = makeAuditWriter();
  const events = makeEventBus();
  const paymentProviders = makePaymentProviderRegistry({
    adapter: mock({ listTransactions: async () => [] }),
  });
  const platformConfig = mock<PlatformConfig>({
    wallet: {
      reconciliation: {
        cron: '0 * * * *',
        lookbackHours: 24,
        batchSize: 2,
        stuckAfterMinutes: 60,
        staleRunAfterMinutes: 30,
        alertThreshold: 10,
        outboxLagAlertMinutes: 5,
        deadLetterAlertThreshold: 0,
      },
    },
  });
  const walletService = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock(),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
    platformConfig,
    rates: makeExchangeRateReader(),
  });
  const reconciliation = new ReconciliationService({
    drizzle: db.drizzle,
    events,
    wallet: walletService,
    paymentProviders,
    audit,
    platformConfig,
    ...extra,
  });
  return { reconciliation, events };
}

async function findingsOf(kind: WalletReconciliationFindingKind) {
  return db.drizzle.db
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.kind, kind));
}

async function runOf(runId: string | undefined) {
  const [run] = await db.drizzle.db
    .select()
    .from(walletJobRun)
    .where(eq(walletJobRun.runId, runId ?? ''));
  return run;
}

async function seedWallet() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: no row'),
  );
}

async function seedMove(
  walletId: string,
  values: { type?: 'bet' | 'win'; providerName?: string; createdAt?: Date; amount?: string } = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: values.type ?? 'bet',
        amount: values.amount ?? '10',
        currency: 'USD',
        status: 'completed',
        providerName: values.providerName ?? PROVIDER,
        providerRefId: `ref-${randomUUID()}`,
        createdAt: values.createdAt ?? new Date(),
      })
      .returning(),
    new Error('seedMove: no row'),
  );
}

async function seedRequest(values: {
  providerRefId: string;
  transactionId: string;
  userId: string;
  amount: string;
  createdAt?: Date;
}) {
  await db.drizzle.db.insert(ledgerApiRequest).values({
    providerName: PROVIDER,
    providerRefId: values.providerRefId,
    operation: 'bet',
    fingerprint: 'print',
    response: {
      transactionId: values.transactionId,
      reversalTransactionId: null,
      roundId: randomUUID(),
      balance: '90',
      currency: 'USD',
    },
    userId: values.userId,
    amount: values.amount,
    createdAt: values.createdAt ?? new Date(),
  });
}

describe('reconciliation: Ledger API requests against the ledger (real PG)', () => {
  it('files one finding for a request whose row differs or is missing, and none on rerun', async () => {
    const w = await seedWallet();
    const matching = await seedMove(w.id);
    await seedRequest({
      providerRefId: matching.providerRefId ?? '',
      transactionId: matching.id,
      userId: w.userId,
      amount: '10',
    });
    const wrongAmount = await seedMove(w.id);
    await seedRequest({
      providerRefId: wrongAmount.providerRefId ?? '',
      transactionId: wrongAmount.id,
      userId: w.userId,
      amount: '12',
    });
    const otherPlayer = await seedMove(w.id);
    await seedRequest({
      providerRefId: otherPlayer.providerRefId ?? '',
      transactionId: otherPlayer.id,
      userId: randomUUID(),
      amount: '10',
    });
    await seedRequest({
      providerRefId: `ref-${randomUUID()}`,
      transactionId: randomUUID(),
      userId: w.userId,
      amount: '10',
    });
    const { reconciliation, events } = makeReconciliation();
    const alerts = () =>
      events.emitInTransaction.mock.calls.filter(
        ([, event]) => event === 'wallet.reconciliation.alert',
      );

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const findings = await findingsOf('ledger_request_mismatch');
    expect(findings).toHaveLength(3);
    // Two pages of mismatches, one alert: the check's, in the run that filed them.
    expect(alerts()).toHaveLength(1);
    expect(await reconciliation.isLedgerFinding(findings[0]?.id ?? '')).toBe(true);
    expect(findings.map((f) => f.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/which has amount 10/),
        expect.stringMatching(/not on the ledger/),
        expect.stringMatching(/which has user /),
      ]),
    );
    expect(findings.every((f) => f.providerName === PROVIDER)).toBe(true);
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ threshold: 0 }),
    );
  });

  it('flags a move with no request from a provider on the Ledger API, never one from before', async () => {
    const w = await seedWallet();
    const legacy = await seedMove(w.id, { createdAt: minutesAgo(120) });
    const first = await seedMove(w.id, { createdAt: minutesAgo(60) });
    await seedRequest({
      providerRefId: first.providerRefId ?? '',
      transactionId: first.id,
      userId: w.userId,
      amount: '10',
      createdAt: minutesAgo(60),
    });
    const around = await seedMove(w.id, { type: 'win', createdAt: minutesAgo(30) });
    await seedMove(w.id, { providerName: 'legacy-studio', createdAt: minutesAgo(30) });
    const { reconciliation } = makeReconciliation();

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const findings = await findingsOf('ledger_unrequested_transaction');
    expect(findings.map((f) => f.transactionId)).toEqual([around.id]);
    expect(findings[0]?.externalId).toBe(around.providerRefId);
    expect(findings.some((f) => f.transactionId === legacy.id)).toBe(false);
  });
});

describe('reconciliation: projections against their owners (real PG)', () => {
  const eligibility = (
    userId: string,
    version: number,
    rgBlocked = true,
  ): PlayEligibilitySnapshot => ({
    userId,
    rgBlocked,
    rgBlockedUntil: null,
    isActive: true,
    banned: false,
    banExpires: null,
    status: 'active',
    version,
  });
  const userOf = (externalId: string | null) => externalId?.split(':')[0];
  const setBlocked = (userId: string, rgBlocked: boolean) =>
    db.drizzle.db
      .update(ledgerPlayEligibility)
      .set({ rgBlocked })
      .where(eq(ledgerPlayEligibility.userId, userId));

  /** An owner holding `owner`; its writer records each re-publish and settles nothing. */
  function playOwner(owner: PlayEligibilitySnapshot[], now = owner) {
    const repaired: string[][] = [];
    const source = {
      page: async (after: string | null) => (after ? [] : owner),
      snapshots: async (userIds: readonly string[]) =>
        now.filter((s) => userIds.includes(s.userId)),
      repair: async (userIds: readonly string[]) => {
        repaired.push([...userIds]);
        return [];
      },
    };
    return { source, repaired };
  }

  it('catches a player behind up from the owner snapshot, then closes the finding', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const behind = randomUUID();
    const missing = randomUUID();
    const level = randomUUID();
    const owner = [behind, missing, level].sort().map((userId) => eligibility(userId, 2));
    await projection.reconcile([eligibility(behind, 1), eligibility(level, 2)]);
    const { source, repaired } = playOwner(owner);
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    await reconciliation.runCycle();

    const filed = await findingsOf('play_eligibility_drift');
    expect(filed.map((f) => userOf(f.externalId)).sort()).toEqual([behind, missing].sort());
    expect(filed.every((f) => f.status === 'open')).toBe(true);
    expect(repaired).toEqual([]);
    expect(await projection.compare(owner)).toEqual({ behind: [], differing: [], ahead: [] });

    await reconciliation.runCycle();

    const after = await findingsOf('play_eligibility_drift');
    expect(after).toHaveLength(2);
    expect(after.every((f) => f.status === 'resolved')).toBe(true);
  });

  it('files again when a drift is dismissed while it lasts, or comes back at the same version', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const player = randomUUID();
    await projection.reconcile([eligibility(player, 2)]);
    await setBlocked(player, false);
    const { source, repaired } = playOwner([eligibility(player, 2)]);
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    await reconciliation.runCycle();
    expect(repaired).toEqual([[player]]);
    await db.drizzle.db
      .update(walletReconciliationFinding)
      .set({ status: 'resolved', resolutionNote: 'dismissed' });
    await reconciliation.runCycle();

    let filed = await findingsOf('play_eligibility_drift');
    expect(filed).toHaveLength(2);
    expect(filed.filter((f) => f.status === 'open')).toHaveLength(1);

    await setBlocked(player, true);
    await reconciliation.runCycle();
    expect((await findingsOf('play_eligibility_drift')).every((f) => f.status === 'resolved')).toBe(
      true,
    );

    await setBlocked(player, false);
    await reconciliation.runCycle();

    filed = await findingsOf('play_eligibility_drift');
    expect(filed).toHaveLength(3);
    expect(filed.filter((f) => f.status === 'open').map((f) => userOf(f.externalId))).toEqual([
      player,
    ]);
  });

  it('counts play eligibility still ahead of its owner as drift, never one a write between the reads moved on', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const ahead = randomUUID();
    const raced = randomUUID();
    await projection.reconcile([eligibility(ahead, 3, false), eligibility(raced, 3, false)]);
    const owner = [ahead, raced].sort().map((userId) => eligibility(userId, 2));
    // `raced` committed version 3 after its page was read: the re-read sees it caught up.
    const { source, repaired } = playOwner(owner, [
      eligibility(ahead, 2),
      eligibility(raced, 3, false),
    ]);
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    await reconciliation.runCycle();

    const filed = await findingsOf('play_eligibility_drift');
    expect(filed.map((f) => userOf(f.externalId))).toEqual([ahead]);
    expect(repaired).toEqual([[ahead]]);
  });

  it('counts a limits projection still ahead of its owner as drift, never one a write between the reads moved on', async () => {
    const projection = new LedgerRgLimitsService(db.drizzle, undefined);
    const ahead = randomUUID();
    const raced = randomUUID();
    const stale = randomUUID();
    const limit = (version: number, amount: string) => ({
      version,
      limits: [
        {
          limitId: '00000000-0000-4000-8000-000000000001',
          type: 'wager' as const,
          period: 'daily' as const,
          amount,
          currency: 'USD',
          changedAt: new Date(0).toISOString(),
        },
      ],
    });
    await projection.reconcile([{ userId: ahead, ...limit(5, '50') }]);
    await projection.reconcile([{ userId: raced, ...limit(5, '50') }]);
    await projection.reconcile([{ userId: stale, ...limit(1, '50') }]);
    const owner: RgLimitsSnapshot[] = [
      { userId: ahead, ...limit(4, '80') },
      { userId: raced, ...limit(4, '80') },
      { userId: stale, ...limit(3, '20') },
    ].sort((a, b) => a.userId.localeCompare(b.userId));
    // `raced` committed version 5 after its page was read: the re-read sees it caught up.
    const ownerNow = (userId: string): RgLimitsSnapshot =>
      userId === raced
        ? { userId, ...limit(5, '50') }
        : (owner.find((s) => s.userId === userId) ?? { userId, version: 0, limits: [] });
    const source = {
      page: async (after: string | null) => (after ? [] : owner),
      snapshots: async (userIds: readonly string[]) => userIds.map(ownerNow),
      repair: async () => [],
    };
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('rg_limits_drift', source, projection)],
    });

    await reconciliation.runCycle();

    const filed = await findingsOf('rg_limits_drift');
    expect(filed.map((f) => userOf(f.externalId)).sort()).toEqual([ahead, stale].sort());
  });

  it('re-publishes at most a page of players through the owner a cycle, and notes the rest', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const players = [randomUUID(), randomUUID(), randomUUID()].sort();
    await projection.reconcile(players.map((userId) => eligibility(userId, 2)));
    for (const userId of players) {
      await setBlocked(userId, false);
    }
    const owner = players.map((userId) => eligibility(userId, 2));
    const repaired: string[] = [];
    const source = {
      page: async (after: string | null) =>
        owner.filter((s) => after === null || s.userId > after).slice(0, 2),
      snapshots: async () => [],
      repair: async (userIds: readonly string[]) => {
        repaired.push(...userIds);
        return [];
      },
    };
    const { reconciliation, events } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    const result = await reconciliation.runCycle();

    expect(repaired).toEqual(players.slice(0, 2));
    expect(await findingsOf('play_eligibility_drift')).toHaveLength(3);
    expect((await runOf(result?.runId))?.summary).toMatchObject({ projectionRepairsDeferred: 1 });
    expect(events.emitInTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ runId: result?.runId, projectionRepairsDeferred: 1 }),
    );
  });

  it('spends the repair cap on successes, so players who keep failing do not starve the rest', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const players = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    await projection.reconcile(players.map((userId) => eligibility(userId, 2)));
    for (const userId of players) {
      await setBlocked(userId, false);
    }
    const owner = players.map((userId) => eligibility(userId, 2));
    const failing = new Set<string>(players.slice(0, 2));
    const repaired: string[] = [];
    const source = {
      page: async (after: string | null) =>
        owner.filter((s) => after === null || s.userId > after).slice(0, 2),
      snapshots: async () => [],
      repair: async (userIds: readonly string[]) => {
        repaired.push(...userIds.filter((userId) => !failing.has(userId)));
        return userIds.filter((userId) => failing.has(userId));
      },
    };
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    const result = await reconciliation.runCycle();

    expect(repaired).toEqual(players.slice(2));
    expect((await runOf(result?.runId))?.summary).toMatchObject({
      projectionRepairsDeferred: 0,
      failedChecks: ['play_eligibility_drift:repair'],
    });
  });
});

describe('reconciliation: event delivery backlog (real PG)', () => {
  async function seedOutbox(occurredAt: Date) {
    const eventId = randomUUID();
    await db.drizzle.db
      .insert(eventOutbox)
      .values({ eventId, topic: 'wallet.deposit.completed', payload: {}, occurredAt });
    return eventId;
  }

  it('files one lag finding while the outbox is stuck, closes it once relayed, files the next', async () => {
    const stuck = await seedOutbox(minutesAgo(10));
    await seedOutbox(minutesAgo(8));
    await seedOutbox(new Date());
    const { reconciliation, events } = makeReconciliation();

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const filed = await findingsOf('outbox_relay_lag');
    expect(filed).toHaveLength(1);
    expect(filed[0]?.externalId?.startsWith(`${stuck}:`)).toBe(true);
    expect(filed[0]?.status).toBe('open');
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ threshold: 0 }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.reconciliation.alert',
      expect.objectContaining({ threshold: 0 }),
    );

    await db.drizzle.db.update(eventOutbox).set({ publishedAt: new Date() });
    await reconciliation.runCycle();

    expect((await findingsOf('outbox_relay_lag'))[0]?.status).toBe('resolved');

    const next = await seedOutbox(minutesAgo(10));
    await reconciliation.runCycle();

    const open = (await findingsOf('outbox_relay_lag')).filter((f) => f.status === 'open');
    expect(open.map((f) => f.externalId?.split(':')[0])).toEqual([next]);
  });

  it('files the lag again when its finding is dismissed while the outbox stays stuck', async () => {
    const stuck = await seedOutbox(minutesAgo(10));
    const { reconciliation } = makeReconciliation();

    await reconciliation.runCycle();
    await db.drizzle.db
      .update(walletReconciliationFinding)
      .set({ status: 'resolved', resolutionNote: 'dismissed' });
    await reconciliation.runCycle();

    const filed = await findingsOf('outbox_relay_lag');
    expect(filed).toHaveLength(2);
    expect(
      filed.filter((f) => f.status === 'open').map((f) => f.externalId?.split(':')[0]),
    ).toEqual([stuck]);
  });

  it('files no lag finding for a backlog younger than the threshold', async () => {
    await seedOutbox(minutesAgo(2));
    const { reconciliation } = makeReconciliation();

    await reconciliation.runCycle();

    expect(await findingsOf('outbox_relay_lag')).toHaveLength(0);
  });

  it('files one dead-letter finding per incident, not one per event, even at a count seen before', async () => {
    let deadLetters: DeadLetters = { count: 3, newest: 'oss:dlq:a/1-0' };
    const broker = { deadLetters: async () => deadLetters };
    const { reconciliation, events } = makeReconciliation({ broker });

    await reconciliation.runCycle();
    deadLetters = { count: 4, newest: 'oss:dlq:a/2-0' };
    await reconciliation.runCycle();

    const filed = await findingsOf('event_dead_letters');
    expect(filed).toHaveLength(1);
    expect(filed[0]?.externalId).toBe('oss:dlq:a/1-0');

    deadLetters = { count: 0, newest: null };
    await reconciliation.runCycle();
    expect((await findingsOf('event_dead_letters'))[0]?.status).toBe('resolved');

    events.emitInTransaction.mockClear();
    deadLetters = { count: 3, newest: 'oss:dlq:b/3-0' };
    await reconciliation.runCycle();

    const open = (await findingsOf('event_dead_letters')).filter((f) => f.status === 'open');
    expect(open.map((f) => f.externalId)).toEqual(['oss:dlq:b/3-0']);
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ threshold: 0 }),
    );
  });
});

describe('reconciliation: a failing check (real PG)', () => {
  it('completes every run, the other checks still file, and each run alerts naming it', async () => {
    await db.drizzle.db.insert(eventOutbox).values({
      eventId: randomUUID(),
      topic: 'wallet.deposit.completed',
      payload: {},
      occurredAt: minutesAgo(10),
    });
    const failing = {
      page: async (): Promise<PlayEligibilitySnapshot[]> => {
        throw new Error('owner unreachable');
      },
      snapshots: async () => [],
      repair: async () => [],
    };
    const broker = {
      deadLetters: async (): Promise<DeadLetters> => {
        throw new Error('SCAN denied');
      },
    };
    const { reconciliation, events } = makeReconciliation({
      broker,
      projectionChecks: [
        projectionDriftCheck(
          'play_eligibility_drift',
          failing,
          new LedgerPlayEligibilityService(db.drizzle),
        ),
      ],
    });

    const runs = [await reconciliation.runCycle(), await reconciliation.runCycle()];

    for (const result of runs) {
      const run = await runOf(result?.runId);
      expect(run?.status).toBe('completed');
      expect(run?.summary).toMatchObject({
        failedChecks: ['play_eligibility_drift', 'event_dead_letters'],
      });
      expect(events.emitInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        'wallet.reconciliation.alert',
        expect.objectContaining({
          runId: result?.runId,
          threshold: 10,
          failedChecks: ['play_eligibility_drift', 'event_dead_letters'],
        }),
      );
    }
    expect(await findingsOf('outbox_relay_lag')).toHaveLength(1);
  });

  it('alerts naming the owner re-publish that failed', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const player = randomUUID();
    await projection.reconcile([{ ...eligibilityOf(player), rgBlocked: false }]);
    const source = {
      page: async (after: string | null) => (after ? [] : [eligibilityOf(player)]),
      snapshots: async () => [],
      repair: async (userIds: readonly string[]) => [...userIds],
    };
    const { reconciliation, events } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    const result = await reconciliation.runCycle();

    expect((await runOf(result?.runId))?.summary).toMatchObject({
      failedChecks: ['play_eligibility_drift:repair'],
    });
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ failedChecks: ['play_eligibility_drift:repair'] }),
    );
  });
});

function eligibilityOf(userId: string): PlayEligibilitySnapshot {
  return {
    userId,
    rgBlocked: true,
    rgBlockedUntil: null,
    isActive: true,
    banned: false,
    banExpires: null,
    status: 'active',
    version: 2,
  };
}
