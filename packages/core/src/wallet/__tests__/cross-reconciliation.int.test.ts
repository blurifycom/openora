import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { eventOutbox, findOneOrThrow } from '@openora/core/server';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import type {
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

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const findings = await findingsOf('ledger_request_mismatch');
    expect(findings).toHaveLength(3);
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
  const eligibility = (userId: string, version: number): PlayEligibilitySnapshot => ({
    userId,
    rgBlocked: true,
    rgBlockedUntil: null,
    isActive: true,
    banned: false,
    banExpires: null,
    status: 'active',
    version,
  });

  it('files one drift per player, keeps it across reruns, and closes it once repaired', async () => {
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    const behind = randomUUID();
    const missing = randomUUID();
    const level = randomUUID();
    const owner = [behind, missing, level].sort().map((userId) => eligibility(userId, 2));
    await projection.reconcile([eligibility(behind, 1), eligibility(level, 2)]);
    const source = { page: async (after: string | null) => (after ? [] : owner) };
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('play_eligibility_drift', source, projection)],
    });

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const filed = await findingsOf('play_eligibility_drift');
    expect(filed.map((f) => f.externalId).sort()).toEqual([`${behind}:2`, `${missing}:2`].sort());

    await projection.reconcile(owner);
    await reconciliation.runCycle();

    const after = await findingsOf('play_eligibility_drift');
    expect(after).toHaveLength(2);
    expect(after.every((f) => f.status === 'resolved')).toBe(true);
  });

  it('does not count a limits projection ahead of the snapshot as drift', async () => {
    const projection = new LedgerRgLimitsService(db.drizzle, undefined);
    const ahead = randomUUID();
    const stale = randomUUID();
    const limit = (version: number, amount: string) => ({
      version,
      limits: [
        {
          limitId: randomUUID(),
          type: 'wager' as const,
          period: 'daily' as const,
          amount,
          currency: 'USD',
          changedAt: new Date(0).toISOString(),
        },
      ],
    });
    await projection.reconcile([{ userId: ahead, ...limit(5, '50') }]);
    await projection.reconcile([{ userId: stale, ...limit(1, '50') }]);
    const owner: RgLimitsSnapshot[] = [
      { userId: ahead, ...limit(4, '80') },
      { userId: stale, ...limit(3, '20') },
    ].sort((a, b) => a.userId.localeCompare(b.userId));
    const source = { page: async (after: string | null) => (after ? [] : owner) };
    const { reconciliation } = makeReconciliation({
      projectionChecks: [projectionDriftCheck('rg_limits_drift', source, projection)],
    });

    await reconciliation.runCycle();

    const filed = await findingsOf('rg_limits_drift');
    expect(filed.map((f) => f.externalId)).toEqual([`${stale}:3`]);
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

  it('files one lag finding while the outbox is stuck and closes it once relayed', async () => {
    const stuck = await seedOutbox(minutesAgo(10));
    await seedOutbox(minutesAgo(8));
    await seedOutbox(new Date());
    const { reconciliation, events } = makeReconciliation();

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const filed = await findingsOf('outbox_relay_lag');
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ externalId: stuck, status: 'open' });
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.objectContaining({ threshold: 0 }),
    );

    await db.drizzle.db.update(eventOutbox).set({ publishedAt: new Date() });
    await reconciliation.runCycle();

    expect((await findingsOf('outbox_relay_lag'))[0]?.status).toBe('resolved');
  });

  it('files no lag finding for a backlog younger than the threshold', async () => {
    await seedOutbox(minutesAgo(2));
    const { reconciliation } = makeReconciliation();

    await reconciliation.runCycle();

    expect(await findingsOf('outbox_relay_lag')).toHaveLength(0);
  });

  it('files one dead-letter finding past the threshold, not one per event', async () => {
    let deadLetters = 3;
    const broker = { deadLetterCount: async () => deadLetters };
    const { reconciliation } = makeReconciliation({ broker });

    await reconciliation.runCycle();
    deadLetters = 4;
    await reconciliation.runCycle();

    const filed = await findingsOf('event_dead_letters');
    expect(filed).toHaveLength(1);
    expect(filed[0]?.externalId).toBe('3');

    deadLetters = 0;
    await reconciliation.runCycle();

    expect((await findingsOf('event_dead_letters'))[0]?.status).toBe('resolved');
  });
});
