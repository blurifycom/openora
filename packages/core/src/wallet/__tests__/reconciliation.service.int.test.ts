import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import type {
  IdentityReader,
  PaymentAdapter,
  PaymentWebhookEvent,
  PlatformConfig,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';
import {
  ReconciliationService,
  ReconciliationCreditMismatchError,
  ReconciliationFindingNotFoundError,
} from '../service/reconciliation.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletCustodySweep}, ${walletJobRun}, ${walletReconciliationFinding}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

const RECONCILIATION_CONFIG: NonNullable<PlatformConfig['wallet']>['reconciliation'] = {
  cron: '0 * * * *',
  lookbackHours: 24,
  batchSize: 200,
  stuckAfterMinutes: 60,
  staleRunAfterMinutes: 30,
  alertThreshold: 10,
};

function makeServices(
  payment: PaymentAdapter,
  overrides: {
    platformConfig?: Partial<PlatformConfig['wallet']>;
    identityReader?: ReturnType<typeof makeIdentityReader>;
  } = {},
) {
  const paymentProviders = makePaymentProviderRegistry({ adapter: payment });
  const audit = makeAuditWriter();
  const events = makeEventBus();
  const platformConfig = mock<PlatformConfig>({
    wallet: { reconciliation: RECONCILIATION_CONFIG, ...overrides.platformConfig },
  });
  const wallet = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    paymentProviders,
    audit,
    identityReader: overrides.identityReader ?? makeIdentityReader(),
    platformConfig,
  });
  const reconciliation = new ReconciliationService({
    drizzle: db.drizzle,
    events,
    wallet,
    paymentProviders,
    audit,
    platformConfig,
  });
  return { wallet, reconciliation, audit, events };
}

async function seedWallet(currency = 'BTC', balance = '0') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount: balance });
  return row;
}

async function balanceOf(walletId: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(walletBalance)
    .where(eq(walletBalance.walletId, walletId));
  return row?.amount ?? '0';
}

async function findingRows() {
  return db.drizzle.db.select().from(walletReconciliationFinding);
}

function listTransactionsReturning(events: PaymentWebhookEvent[]): PaymentAdapter {
  return mock<PaymentAdapter>({ listTransactions: vi.fn(async () => events) });
}

/**
 * Poll until a claim row lands (`finishedAt IS NULL`), instead of assuming a fixed
 * delay ran long enough to observe it - the assumption a fixed wait made is exactly
 * what made the concurrency test below flaky under CI's less predictable scheduling.
 */
async function waitForOpenClaim(jobName: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db.drizzle.db
      .select({ id: walletJobRun.id })
      .from(walletJobRun)
      .where(and(eq(walletJobRun.jobName, jobName), isNull(walletJobRun.finishedAt)));
    if (row) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForOpenClaim: no open claim for '${jobName}' within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ReconciliationService.runCycle - internal transfer exclusion', () => {
  it('produces zero findings for a sweep that appears in the vendor transaction list', async () => {
    const w = await seedWallet();
    const sweepExternalId = randomUUID();
    await db.drizzle.db.insert(walletCustodySweep).values({
      userId: w.userId,
      providerName: 'default',
      currency: 'BTC',
      network: 'BTC',
      amount: '5',
      estimatedFee: '0.0001',
      externalId: sweepExternalId,
      status: 'completed',
    });
    // The vendor's own ledger reports the sweep back as a transaction with no ledger
    // row on our side - exactly the shape that would file a false missing_deposit if
    // the exclusion were skipped.
    const payment = listTransactionsReturning([
      {
        kind: 'deposit',
        address: 'pool-address',
        amount: '5',
        currency: 'BTC',
        txHash: '0xsweep',
        externalId: sweepExternalId,
      },
    ]);
    const { reconciliation } = makeServices(payment);

    const result = await reconciliation.runCycle();

    expect(result).not.toBeNull();
    expect(await findingRows()).toHaveLength(0);
  });
});

describe('ReconciliationService.runCycle - missing deposit', () => {
  it('produces a finding and zero balance change', async () => {
    const w = await seedWallet('BTC', '2');
    const externalId = randomUUID();
    const payment = listTransactionsReturning([
      {
        kind: 'deposit',
        address: 'bc1qmissing',
        amount: '1',
        currency: 'BTC',
        txHash: '0xmissing',
        externalId,
      },
    ]);
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing_deposit', status: 'open', externalId });
    expect(await balanceOf(w.id)).toBe('2.000000000000000000');
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
  });

  it('does not duplicate the finding when the same window is reconciled again', async () => {
    const externalId = randomUUID();
    const payment = listTransactionsReturning([
      {
        kind: 'deposit',
        address: 'bc1qmissing',
        amount: '1',
        currency: 'BTC',
        txHash: '0xmissing',
        externalId,
      },
    ]);
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
  });
});

describe('ReconciliationService.runCycle - amount and currency mismatch', () => {
  it('flags amount_mismatch when the ledger amount differs from the vendor report', async () => {
    const w = await seedWallet();
    const externalId = randomUUID();
    const tx = findOneOrThrow(
      await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId: w.id,
          type: 'deposit',
          amount: '1',
          currency: 'BTC',
          status: 'completed',
          rail: 'crypto',
          providerRefId: externalId,
        })
        .returning(),
      new Error('seed: insert returned no row'),
    );

    const payment = listTransactionsReturning([
      {
        kind: 'deposit',
        address: 'bc1qamount',
        amount: '2',
        currency: 'BTC',
        txHash: '0xamount',
        externalId,
      },
    ]);
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'amount_mismatch', transactionId: tx.id });
  });
});

describe('ReconciliationService.runCycle - stuck withdrawals', () => {
  async function seedStuckWithdrawal(providerRefId: string) {
    const w = await seedWallet('BTC', '5');
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const tx = findOneOrThrow(
      await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId: w.id,
          type: 'withdrawal',
          amount: '1',
          currency: 'BTC',
          status: 'processing',
          rail: 'crypto',
          providerName: 'default',
          providerRefId,
          createdAt: oldDate,
        })
        .returning(),
      new Error('seedStuckWithdrawal: query returned no row'),
    );
    return { w, tx };
  }

  it('finalizes through reconcileWithdrawalStatus and refunds exactly once when it comes back failed', async () => {
    const providerRefId = randomUUID();
    const { w } = await seedStuckWithdrawal(providerRefId);
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      getWithdrawalStatus: vi.fn(async () => ({ status: 'failed' as const })),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    expect(await balanceOf(w.id)).toBe('6.000000000000000000');
    const [tx] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.walletId, w.id));
    expect(tx?.status).toBe('failed');

    // Re-running must not refund a second time: the withdrawal is no longer
    // `processing`, so it no longer matches the stuck-withdrawal query at all.
    await reconciliation.runCycle();
    expect(await balanceOf(w.id)).toBe('6.000000000000000000');
  });

  it('a permanently stuck withdrawal does not starve later ones out of the batch', async () => {
    await seedStuckWithdrawal(randomUUID());
    await seedStuckWithdrawal(randomUUID());
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      getWithdrawalStatus: vi.fn(async () => null),
    });
    const { reconciliation } = makeServices(payment, {
      platformConfig: { reconciliation: { ...RECONCILIATION_CONFIG, batchSize: 1 } },
    });

    await reconciliation.runCycle();
    expect(await findingRows()).toHaveLength(1);

    // The oldest row keeps matching the query forever (a finding never resolves it), so
    // an oldest-first batch of 1 would report it again and never reach the second row.
    await reconciliation.runCycle();
    expect(await findingRows()).toHaveLength(2);
  });

  it('files an unknown_at_provider finding when the vendor has no record', async () => {
    const providerRefId = randomUUID();
    await seedStuckWithdrawal(providerRefId);
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      getWithdrawalStatus: vi.fn(async () => null),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'unknown_at_provider', externalId: providerRefId });
  });
});

describe('ReconciliationService.runCycle - claim concurrency', () => {
  it('the second of two concurrent cycles returns immediately', async () => {
    // A cycle that finishes (clearing the claim) before the sibling's own claim
    // attempt is even issued would let both legitimately succeed as two SEPARATE runs
    // rather than actually racing - that is the real race this test exists to prove.
    // Hold the first cycle open on an explicit gate and poll for its claim row instead
    // of guessing a fixed delay is long enough: a fixed wait is exactly what made this
    // test flaky under CI's less predictable scheduling.
    let releaseFirstCycle!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstCycle = resolve;
    });
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => {
        await gate;
        return [];
      }),
    });
    const { reconciliation } = makeServices(payment);

    const first = reconciliation.runCycle();
    await waitForOpenClaim('wallet-reconciliation');

    const second = await reconciliation.runCycle();
    releaseFirstCycle();

    const results = [await first, second];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});

describe('ReconciliationService.runCycle - retried run', () => {
  it('a queue retry carrying the same runId does not rewrite the failed attempt', async () => {
    // BullMQ retries a job with the SAME payload, so both attempts share a runId. If
    // the finish update keyed on runId instead of the claimed row, the retry's success
    // would reach back and stamp `completed` over the first attempt - erasing the only
    // record that reconciliation ever failed.
    const runId = randomUUID();
    const listTransactions = vi
      .fn()
      .mockRejectedValueOnce(new Error('vendor 503'))
      .mockResolvedValue([]);
    const { reconciliation } = makeServices(mock<PaymentAdapter>({ listTransactions }));

    await expect(reconciliation.runCycle(runId)).rejects.toThrow('vendor 503');
    expect(await reconciliation.runCycle(runId)).toEqual({ runId });

    const runs = await db.drizzle.db
      .select()
      .from(walletJobRun)
      .where(eq(walletJobRun.runId, runId));
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
  });
});

describe('ReconciliationService.runCycle - audit', () => {
  it('audits the run and each finding, with no address or tx hash in either payload', async () => {
    const externalId = randomUUID();
    const payment = listTransactionsReturning([
      {
        kind: 'deposit',
        address: 'bc1qaudited',
        amount: '1',
        currency: 'BTC',
        txHash: '0xaudited',
        externalId,
      },
    ]);
    const { reconciliation, audit } = makeServices(payment);

    await reconciliation.runCycle();

    const entries = (audit.record as ReturnType<typeof vi.fn>).mock.calls.map(
      ([entry]) => entry as Record<string, unknown>,
    );
    expect(entries.map((e) => e.action)).toEqual([
      'wallet.reconciliation_finding.recorded',
      'wallet.reconciliation_run.completed',
    ]);
    const payload = JSON.stringify(entries);
    expect(payload).not.toContain('bc1qaudited');
    expect(payload).not.toContain('0xaudited');
  });
});

describe('ReconciliationService.resolveFinding', () => {
  async function seedFinding(kind: 'missing_deposit' = 'missing_deposit') {
    const runId = randomUUID();
    await db.drizzle.db.insert(walletJobRun).values({ jobName: 'wallet-reconciliation', runId });
    const [row] = await db.drizzle.db
      .insert(walletReconciliationFinding)
      .values({
        runId,
        providerName: 'default',
        kind,
        currency: 'BTC',
        amount: '1',
        externalId: randomUUID(),
      })
      .returning();
    return findOneOrThrow([row], new Error('seedFinding: insert returned no row'));
  }

  it('rejects a credited resolution whose transaction amount does not match the finding', async () => {
    const finding = await seedFinding();
    const w = await seedWallet('BTC', '0');
    const payment = listTransactionsReturning([]);
    const { wallet: walletSvc, reconciliation } = makeServices(payment, {
      identityReader: mock<IdentityReader>({
        ...makeIdentityReader(),
        getPlayerIdByUserId: vi.fn().mockResolvedValue(randomUUID()),
      }),
    });
    const creditTx = await walletSvc.manualAdjust({
      adminId: randomUUID(),
      userId: w.userId,
      direction: 'credit',
      amount: '999',
      currency: 'BTC',
      reason: 'test',
      idempotencyKey: randomUUID(),
      ip: null,
      userAgent: null,
    });

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, {
        outcome: 'credited',
        transactionId: creditTx.transactionId,
      }),
    ).rejects.toBeInstanceOf(ReconciliationCreditMismatchError);
  });

  it('accepts a credited resolution whose manual-credit transaction matches exactly', async () => {
    const finding = await seedFinding();
    const w = await seedWallet('BTC', '0');
    const payment = listTransactionsReturning([]);
    const { wallet: walletSvc, reconciliation } = makeServices(payment, {
      identityReader: mock<IdentityReader>({
        ...makeIdentityReader(),
        getPlayerIdByUserId: vi.fn().mockResolvedValue(randomUUID()),
      }),
    });
    const creditTx = await walletSvc.manualAdjust({
      adminId: randomUUID(),
      userId: w.userId,
      direction: 'credit',
      amount: '1',
      currency: 'BTC',
      reason: 'reconciliation credit',
      idempotencyKey: randomUUID(),
      ip: null,
      userAgent: null,
    });

    const resolved = await reconciliation.resolveFinding(randomUUID(), finding.id, {
      outcome: 'credited',
      transactionId: creditTx.transactionId,
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.transactionId).toBe(creditTx.transactionId);
  });

  it('a double-resolve is a no-op: second call does not write a second audit entry', async () => {
    const finding = await seedFinding();
    const payment = listTransactionsReturning([]);
    const { reconciliation, audit } = makeServices(payment);
    const adminId = randomUUID();

    await reconciliation.resolveFinding(adminId, finding.id, {
      outcome: 'dismissed',
      note: 'confirmed non-issue',
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);

    const second = await reconciliation.resolveFinding(adminId, finding.id, {
      outcome: 'dismissed',
      note: 'a different note this time',
    });

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(second.resolutionNote).toBe('confirmed non-issue');
  });

  it('404s resolving a finding that does not exist', async () => {
    const payment = listTransactionsReturning([]);
    const { reconciliation } = makeServices(payment);

    await expect(
      reconciliation.resolveFinding(randomUUID(), randomUUID(), {
        outcome: 'dismissed',
        note: 'n/a',
      }),
    ).rejects.toBeInstanceOf(ReconciliationFindingNotFoundError);
  });
});
