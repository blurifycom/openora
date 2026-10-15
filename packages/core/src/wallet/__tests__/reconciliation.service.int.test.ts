import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import type {
  DepositHoldPolicy,
  IdentityReader,
  PaymentAdapter,
  PaymentWebhookEvent,
  PlatformConfig,
  RgLimitsPort,
  WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeExchangeRateReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  OUT_OF_CYCLE_RUN_ID,
  lockVendorDeposit,
  recordReconciliationFinding,
} from '../service/reconciliation-finding.service.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
  walletDepositAddress,
} from '../schema/index.js';
import {
  DepositAlreadyOnLedgerError,
  DepositStillHeldError,
  WalletService,
} from '../service/wallet.service.js';
import {
  ReconciliationService,
  DepositAlreadyRefundedError,
  ReconciliationAttributionError,
  ReconciliationCreditMismatchError,
  ReconciliationFindingNotFoundError,
  ReconciliationOutcomeNotAllowedError,
  ReconciliationRefundAmountError,
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
    sql`TRUNCATE ${walletTransaction}, ${walletCustodySweep}, ${walletJobRun}, ${walletReconciliationFinding}, ${walletDepositAddress}, ${wallet} RESTART IDENTITY CASCADE`,
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
    rgLimits?: RgLimitsPort;
    depositHold?: DepositHoldPolicy;
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
    rates: makeExchangeRateReader(),
    depositHold: overrides.depositHold,
  });
  const reconciliation = new ReconciliationService({
    drizzle: db.drizzle,
    events,
    wallet,
    paymentProviders,
    audit,
    platformConfig,
    rgLimits: overrides.rgLimits,
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
          providerName: 'default',
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
  async function seedStuckWithdrawal(providerRefId: string | null) {
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

  it('recovers a payout whose response was lost by looking it up with our own id', async () => {
    const { w, tx } = await seedStuckWithdrawal(null);
    const vendorId = randomUUID();
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      findWithdrawalByReference: vi.fn(async () => ({
        externalId: vendorId,
        status: 'completed' as const,
        txHash: '0xabc',
      })),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    expect(payment.findWithdrawalByReference).toHaveBeenCalledWith(tx.id);
    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, tx.id));
    expect(row).toMatchObject({ status: 'completed', providerRefId: vendorId, txHash: '0xabc' });
    expect(await balanceOf(w.id)).toBe('5.000000000000000000');
    expect(await findingRows()).toHaveLength(0);
  });

  it('never refunds a payout the vendor cannot find by our id - it files a finding instead', async () => {
    const { w, tx } = await seedStuckWithdrawal(null);
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      findWithdrawalByReference: vi.fn(async () => null),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, tx.id));
    expect(row?.status).toBe('processing');
    expect(await balanceOf(w.id)).toBe('5.000000000000000000');
    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'unknown_at_provider', externalId: tx.id });
  });

  it('closes the held withdrawal when its finding is credited by hand, so a late vendor answer cannot pay twice', async () => {
    const { w, tx } = await seedStuckWithdrawal(null);
    const findWithdrawalByReference = vi.fn<
      NonNullable<PaymentAdapter['findWithdrawalByReference']>
    >(async () => null);
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      findWithdrawalByReference,
    });
    const { wallet: walletSvc, reconciliation } = makeServices(payment, {
      identityReader: mock<IdentityReader>({
        ...makeIdentityReader(),
        getPlayerIdByUserId: vi.fn().mockResolvedValue(randomUUID()),
      }),
    });
    await reconciliation.runCycle();
    const [finding] = await findingRows();
    const credit = await walletSvc.manualAdjust({
      adminId: randomUUID(),
      userId: w.userId,
      direction: 'credit',
      amount: '1',
      currency: 'BTC',
      reason: 'withdrawal never left the vendor',
      idempotencyKey: randomUUID(),
      ip: null,
      userAgent: null,
    });

    await reconciliation.resolveFinding(randomUUID(), finding!.id, {
      outcome: 'credited',
      transactionId: credit.transactionId,
    });
    findWithdrawalByReference.mockResolvedValue({
      externalId: randomUUID(),
      status: 'failed' as const,
    });
    await reconciliation.runCycle();

    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, tx.id));
    expect(row?.status).toBe('failed');
    expect(await balanceOf(w.id)).toBe('6.000000000000000000');
  });

  it('measures stuck time from approval, not from the request', async () => {
    const { tx } = await seedStuckWithdrawal(null);
    await db.drizzle.db
      .update(walletTransaction)
      .set({ reviewedAt: new Date() })
      .where(eq(walletTransaction.id, tx.id));
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      findWithdrawalByReference: vi.fn(async () => null),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    expect(payment.findWithdrawalByReference).not.toHaveBeenCalled();
    expect(await findingRows()).toHaveLength(0);
  });

  it('keeps checking the rest of the batch when one vendor lookup throws', async () => {
    const first = await seedStuckWithdrawal(null);
    const second = await seedStuckWithdrawal(null);
    const payment = mock<PaymentAdapter>({
      listTransactions: vi.fn(async () => []),
      findWithdrawalByReference: vi.fn(async (id: string) => {
        if (id === first.tx.id) {
          throw new Error('vendor unreachable');
        }
        return { externalId: randomUUID(), status: 'completed' as const };
      }),
    });
    const { reconciliation } = makeServices(payment);

    await reconciliation.runCycle();

    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, second.tx.id));
    expect(row?.status).toBe('completed');
  });
});

describe('ReconciliationService.runCycle - stuck swaps', () => {
  const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

  async function seedSwapOut(createdAt: Date, providerRefId?: string) {
    const w = await seedWallet('BTC', '4');
    const tx = findOneOrThrow(
      await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId: w.id,
          type: 'swap_out',
          amount: '1',
          currency: 'BTC',
          status: 'processing',
          direction: 'debit',
          rail: 'crypto',
          createdAt,
          ...(providerRefId ? { providerRefId } : {}),
        })
        .returning(),
      new Error('seedSwapOut: query returned no row'),
    );
    return { w, tx };
  }

  it('files a stuck_swap finding for a held swap past the cutoff and moves no money', async () => {
    const { w, tx } = await seedSwapOut(TWO_HOURS_AGO());
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'stuck_swap',
      externalId: tx.id,
      transactionId: tx.id,
      status: 'open',
    });
    expect(await balanceOf(w.id)).toBe('4.000000000000000000');
    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, tx.id));
    expect(row?.status).toBe('processing');
  });

  it('leaves a swap still inside the cutoff alone', async () => {
    await seedSwapOut(new Date());
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await reconciliation.runCycle();

    expect(await findingRows()).toHaveLength(0);
  });

  it('reports a stuck swap once however many cycles see it', async () => {
    await seedSwapOut(TWO_HOURS_AGO());
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await reconciliation.runCycle();
    await reconciliation.runCycle();

    expect(await findingRows()).toHaveLength(1);
  });

  it("files the desk's own reference as externalId when the leg has one", async () => {
    const providerRefId = randomUUID();
    await seedSwapOut(TWO_HOURS_AGO(), providerRefId);
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await reconciliation.runCycle();

    expect((await findingRows())[0]).toMatchObject({ externalId: providerRefId });
  });

  it('honours its own cutoff, not the withdrawal one', async () => {
    // 90 minutes old: past the 60-minute withdrawal cutoff, inside the swap one. A desk
    // that settles slower than withdrawals must not file a finding per healthy swap.
    await seedSwapOut(new Date(Date.now() - 90 * 60 * 1000));
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      platformConfig: {
        reconciliation: { ...RECONCILIATION_CONFIG, stuckSwapAfterMinutes: 240 },
      },
    });

    await reconciliation.runCycle();

    expect(await findingRows()).toHaveLength(0);
  });

  it('closes its own finding once the desk settles the leg, touching no money', async () => {
    const { w, tx } = await seedSwapOut(TWO_HOURS_AGO());
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await reconciliation.runCycle();
    expect((await findingRows())[0]).toMatchObject({ status: 'open' });

    await db.drizzle.db
      .update(walletTransaction)
      .set({ status: 'completed' })
      .where(eq(walletTransaction.id, tx.id));
    await reconciliation.runCycle();

    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: 'resolved', resolvedBy: null });
    expect(findings[0]?.resolvedAt).not.toBeNull();
    expect(await balanceOf(w.id)).toBe('4.000000000000000000');
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
  async function seedFinding(
    kind: WalletReconciliationFindingKind = 'stuck_sweep',
    values: Partial<typeof walletReconciliationFinding.$inferInsert> = {},
  ) {
    const runId = randomUUID();
    await db.drizzle.db
      .insert(walletJobRun)
      .values({ jobName: 'wallet-reconciliation', runId, finishedAt: new Date() });
    const [row] = await db.drizzle.db
      .insert(walletReconciliationFinding)
      .values({
        runId,
        providerName: 'default',
        kind,
        currency: 'BTC',
        amount: '1',
        externalId: randomUUID(),
        ...values,
      })
      .returning();
    return findOneOrThrow([row], new Error('seedFinding: insert returned no row'));
  }

  /** A player wallet with a BTC deposit address, and a missing deposit to that address. */
  async function seedMissingDeposit() {
    const w = await seedWallet('BTC', '0');
    await db.drizzle.db.insert(walletDepositAddress).values({
      userId: w.userId,
      currency: 'BTC',
      network: 'bitcoin',
      address: `bc1q${randomUUID().slice(0, 8)}`,
      providerName: 'default',
    });
    const [address] = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, w.userId));
    const { address: depositAddress } = findOneOrThrow([address], new Error('no address'));
    const externalId = randomUUID();
    const finding = await seedFinding('missing_deposit', {
      externalId,
      network: 'bitcoin',
      address: depositAddress,
      txHash: '0xdeposit',
      sourceAddress: 'bc1qplayer',
    });
    const redelivery = {
      kind: 'deposit' as const,
      address: depositAddress,
      network: 'bitcoin',
      amount: '1',
      currency: 'BTC',
      txHash: '0xdeposit',
      externalId,
    };
    return { w, finding, redelivery };
  }

  const playerReader = () =>
    mock<IdentityReader>({
      ...makeIdentityReader(),
      getPlayerIdByUserId: vi.fn().mockResolvedValue(randomUUID()),
    });

  async function depositRows(walletId: string) {
    return db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(and(eq(walletTransaction.walletId, walletId), eq(walletTransaction.type, 'deposit')));
  }

  async function findingById(id: string) {
    const [row] = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.id, id));
    return row;
  }

  const refund = (amount = '1', destinationAddress = 'bc1qplayer', note?: string) => ({
    outcome: 'refunded' as const,
    amount,
    txHash: '0xrefund',
    destinationAddress,
    ...(note ? { note } : {}),
  });

  it('rejects a credited resolution whose transaction amount does not match the finding', async () => {
    const finding = await seedFinding();
    const w = await seedWallet('BTC', '0');
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
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
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
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

  it('refuses a non-deposit credited resolution that names no manual credit', async () => {
    const finding = await seedFinding();
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'credited' }),
    ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
  });

  it('refuses to close a deposit finding with a manual credit made before the hold policy ran', async () => {
    const { finding } = await seedMissingDeposit();
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, {
        outcome: 'credited',
        transactionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
  });

  it('credits a missing deposit as a deposit the limit window counts, keyed on the vendor id', async () => {
    const { w, finding, redelivery } = await seedMissingDeposit();
    const adminId = randomUUID();
    const policy = holdingPolicy(null);
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
      depositHold: policy,
    });

    const resolved = await reconciliation.resolveFinding(adminId, finding.id, {
      outcome: 'credited',
    });

    expect(policy.holdReason).toHaveBeenCalledWith(expect.anything(), {
      userId: w.userId,
      amount: '1.000000000000000000',
      currency: 'BTC',
    });
    const [deposit] = await depositRows(w.id);
    expect(deposit).toMatchObject({
      id: resolved.transactionId,
      status: 'completed',
      providerName: 'default',
      providerRefId: finding.externalId,
      reviewedBy: adminId,
      reviewedAt: expect.any(Date),
    });
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');

    // The vendor redelivers the same deposit: it replays, it does not credit again.
    await walletSvc.creditDepositByAddress(redelivery);
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
    expect(await depositRows(w.id)).toHaveLength(1);
  });

  it('refuses to credit a restricted player before any money moves', async () => {
    const { w, finding } = await seedMissingDeposit();
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
      depositHold: holdingPolicy('rg_restricted'),
    });

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'credited' }),
    ).rejects.toBeInstanceOf(DepositStillHeldError);
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect(await depositRows(w.id)).toHaveLength(0);
    expect((await findingById(finding.id))?.status).toBe('open');
  });

  it('refuses to credit a deposit to a player other than the one its address was issued to', async () => {
    const { w, finding } = await seedMissingDeposit();
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, {
        outcome: 'credited',
        userId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ReconciliationAttributionError);
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
  });

  it('credits an unattributed deposit only to the player the admin names', async () => {
    const w = await seedWallet('BTC', '0');
    const finding = await seedFinding('unattributed_deposit', { address: 'bc1qnobody' });
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'credited' }),
    ).rejects.toBeInstanceOf(ReconciliationAttributionError);

    await reconciliation.resolveFinding(randomUUID(), finding.id, {
      outcome: 'credited',
      userId: w.userId,
    });
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
  });

  it('credits only the shortfall of an underpaid amount mismatch, and refuses an overpaid one', async () => {
    const w = await seedWallet('BTC', '0');
    const [ledger] = await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'deposit',
        amount: '0.4',
        currency: 'BTC',
        status: 'completed',
        direction: 'credit',
        providerName: 'default',
        providerRefId: randomUUID(),
      })
      .returning();
    const ledgerId = findOneOrThrow([ledger], new Error('no ledger row')).id;
    const underpaid = await seedFinding('amount_mismatch', { transactionId: ledgerId });
    const overpaid = await seedFinding('amount_mismatch', {
      transactionId: ledgerId,
      amount: '0.1',
    });
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });

    await reconciliation.resolveFinding(randomUUID(), underpaid.id, { outcome: 'credited' });
    await expect(
      reconciliation.resolveFinding(randomUUID(), overpaid.id, { outcome: 'credited' }),
    ).rejects.toBeInstanceOf(ReconciliationCreditMismatchError);

    expect(await balanceOf(w.id)).toBe('0.600000000000000000');
  });

  it('refuses a refund for an amount or currency mismatch the player was already credited for', async () => {
    const { reconciliation } = makeServices(listTransactionsReturning([]));
    for (const kind of ['amount_mismatch', 'currency_mismatch'] as const) {
      const finding = await seedFinding(kind);
      await expect(
        reconciliation.resolveFinding(randomUUID(), finding.id, refund()),
      ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
    }
  });

  it('refuses a refund of anything but the whole deposit', async () => {
    const finding = await seedFinding('unattributed_deposit');
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    for (const amount of ['1.5', '0.9']) {
      await expect(
        reconciliation.resolveFinding(randomUUID(), finding.id, refund(amount)),
      ).rejects.toBeInstanceOf(ReconciliationRefundAmountError);
    }
    expect((await findingById(finding.id))?.status).toBe('open');
  });

  it('refuses a refund to an address other than the sender unless a note says why', async () => {
    const finding = await seedFinding('unattributed_deposit', { sourceAddress: 'bc1qsender' });
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, refund('1', 'bc1qelsewhere')),
    ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
    expect((await findingById(finding.id))?.status).toBe('open');

    const resolved = await reconciliation.resolveFinding(
      randomUUID(),
      finding.id,
      refund('1', 'bc1qelsewhere', 'sender is an exchange; player asked for their own wallet'),
    );
    expect(resolved.status).toBe('resolved');
  });

  /** Runs `move` while another transaction holds the vendor deposit lock; reports whether it waited. */
  async function waitsForVendorLock(externalId: string, move: () => Promise<unknown>) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const blocker = db.drizzle.db.transaction(async (txn) => {
      await lockVendorDeposit(txn, 'default', externalId);
      lockTaken();
      await held;
    });
    await taken;
    let settled = false;
    const moving = move().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waited = !settled;
    release();
    await blocker;
    await moving;
    return waited;
  }

  it('serializes an admin resolve and a webhook credit of the same vendor deposit', async () => {
    const { w, redelivery } = await seedMissingDeposit();
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });

    expect(
      await waitsForVendorLock(redelivery.externalId, () =>
        walletSvc.creditDepositByAddress(redelivery),
      ),
    ).toBe(true);
    const unattributed = await seedFinding('unattributed_deposit', { externalId: randomUUID() });
    expect(
      await waitsForVendorLock(unattributed.externalId ?? '', () =>
        reconciliation.resolveFinding(randomUUID(), unattributed.id, refund()),
      ),
    ).toBe(true);
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
  });

  it('records a refunded missing deposit so a vendor redelivery does not credit it', async () => {
    const { w, finding, redelivery } = await seedMissingDeposit();
    const rgLimits = mock<RgLimitsPort>({
      referenceCurrency: vi.fn(async () => null),
      checkDeposit: vi.fn(async () => ({ allowed: true as const })),
    });
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
      rgLimits,
    });

    await reconciliation.resolveFinding(randomUUID(), finding.id, refund());
    const [refunded] = await depositRows(w.id);
    expect(refunded).toMatchObject({
      status: 'refunded',
      providerRefId: finding.externalId,
      amount: '1.000000000000000000',
    });

    await walletSvc.creditDepositByAddress(redelivery);

    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect(await depositRows(w.id)).toHaveLength(1);
    expect(rgLimits.checkDeposit).not.toHaveBeenCalled();
  });

  it('refunds an unattributed deposit once: a redelivery or re-poll files nothing and credits nothing', async () => {
    const externalId = randomUUID();
    const finding = await seedFinding('unattributed_deposit', {
      externalId,
      address: 'bc1qnobody',
      network: 'bitcoin',
    });
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]));
    await reconciliation.resolveFinding(randomUUID(), finding.id, refund());

    await walletSvc.creditDepositByAddress({
      kind: 'deposit',
      address: 'bc1qnobody',
      network: 'bitcoin',
      amount: '1',
      currency: 'BTC',
      txHash: '0xdeposit',
      externalId,
    });
    await recordReconciliationFinding(db.drizzle.db, {
      runId: OUT_OF_CYCLE_RUN_ID,
      providerName: 'default',
      kind: 'missing_deposit',
      currency: 'BTC',
      amount: '1',
      externalId,
    });

    const findings = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.externalId, externalId));
    expect(findings).toEqual([expect.objectContaining({ id: finding.id, status: 'resolved' })]);
    const credits = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.providerRefId, externalId));
    expect(credits).toHaveLength(0);
  });

  it('refuses a second refund, or a credit, of a vendor deposit refunded from another finding', async () => {
    const { w, finding: missing, redelivery } = await seedMissingDeposit();
    const unattributed = await seedFinding('unattributed_deposit', {
      externalId: redelivery.externalId,
    });
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });
    await reconciliation.resolveFinding(randomUUID(), unattributed.id, refund());

    await expect(
      reconciliation.resolveFinding(randomUUID(), missing.id, refund()),
    ).rejects.toBeInstanceOf(DepositAlreadyRefundedError);
    await expect(
      reconciliation.resolveFinding(randomUUID(), missing.id, { outcome: 'credited' }),
    ).rejects.toBeInstanceOf(DepositAlreadyRefundedError);
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect((await findingById(missing.id))?.status).toBe('open');
  });

  it('refuses to refund an unattributed deposit the ledger already credited', async () => {
    const { w, finding: missing, redelivery } = await seedMissingDeposit();
    const unattributed = await seedFinding('unattributed_deposit', {
      externalId: redelivery.externalId,
    });
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });
    await reconciliation.resolveFinding(randomUUID(), missing.id, { outcome: 'credited' });

    await expect(
      reconciliation.resolveFinding(randomUUID(), unattributed.id, refund()),
    ).rejects.toBeInstanceOf(DepositAlreadyOnLedgerError);
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
  });

  it('refuses to refund a missing deposit the webhook has credited in the meantime', async () => {
    const { w, finding, redelivery } = await seedMissingDeposit();
    const { wallet: walletSvc, reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
    });
    await walletSvc.creditDepositByAddress(redelivery);

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, refund()),
    ).rejects.toBeInstanceOf(DepositAlreadyOnLedgerError);
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
    expect((await findingById(finding.id))?.status).toBe('open');
  });

  it('audits the refund amount and whether it went anywhere but the sender', async () => {
    const { reconciliation, audit } = makeServices(listTransactionsReturning([]));
    const cases = [
      { sourceAddress: 'bc1qsender', destination: 'BC1QSENDER', differs: false },
      { sourceAddress: 'bc1qsender', destination: 'bc1qelsewhere', differs: true },
      { sourceAddress: null, destination: 'bc1qelsewhere', differs: null },
    ];
    for (const { sourceAddress, destination, differs } of cases) {
      const finding = await seedFinding('unattributed_deposit', { sourceAddress });
      const resolved = await reconciliation.resolveFinding(
        randomUUID(),
        finding.id,
        refund('1', destination, 'returned to the address the player gave'),
      );
      expect(resolved.resolutionNote).toBe(
        `refunded 1 BTC on chain in 0xrefund to ${destination}: returned to the address the player gave`,
      );
      expect(audit.recordInTransaction).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          after: expect.objectContaining({
            refundAmount: '1',
            refundCurrency: 'BTC',
            refundDestinationDiffersFromSource: differs,
          }),
        }),
      );
    }
  });

  it('files an rg_limit_breach when a hand-credited deposit lands past the player limit', async () => {
    const { w, finding } = await seedMissingDeposit();
    const rgLimits = mock<RgLimitsPort>({
      referenceCurrency: vi.fn(async () => null),
      checkDeposit: vi.fn(async () => ({
        allowed: false as const,
        limitType: 'deposit' as const,
        period: 'daily' as const,
        limit: '0.5',
        used: '1.4',
        currency: 'BTC',
      })),
    });
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
      rgLimits,
    });

    const resolved = await reconciliation.resolveFinding(randomUUID(), finding.id, {
      outcome: 'credited',
    });

    // The credit is a committed deposit row the window already counts, so the gate is asked
    // about nothing more - the same `0` the webhook path asks with.
    expect(rgLimits.checkDeposit).toHaveBeenCalledWith(expect.anything(), w.userId, '0', 'BTC');
    const [breach] = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.externalId, finding.id));
    expect(breach).toMatchObject({
      kind: 'rg_limit_breach',
      status: 'open',
      amount: '1.000000000000000000',
      transactionId: resolved.transactionId,
    });
    expect(breach?.detail).toContain('daily deposit limit of 0.5');
  });

  it('files no breach when the hand-credited deposit stays inside the limit', async () => {
    const { finding } = await seedMissingDeposit();
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      identityReader: playerReader(),
      rgLimits: mock<RgLimitsPort>({
        referenceCurrency: vi.fn(async () => null),
        checkDeposit: vi.fn(async () => ({ allowed: true as const })),
      }),
    });

    await reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'credited' });

    const breaches = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.kind, 'rg_limit_breach'));
    expect(breaches).toHaveLength(0);
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

  async function seedHeldDeposit(walletId: string) {
    const [deposit] = await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'deposit',
        amount: '1',
        currency: 'BTC',
        status: 'on_hold',
        direction: 'credit',
        reviewReason: 'self_excluded',
      })
      .returning();
    const held = findOneOrThrow([deposit], new Error('seedHeldDeposit: insert returned no row'));
    const runId = randomUUID();
    await db.drizzle.db.insert(walletJobRun).values({ jobName: 'wallet-reconciliation', runId });
    const [row] = await db.drizzle.db
      .insert(walletReconciliationFinding)
      .values({
        runId,
        providerName: 'default',
        kind: 'held_deposit',
        currency: 'BTC',
        amount: '1',
        externalId: randomUUID(),
        transactionId: held.id,
      })
      .returning();
    return { held, finding: findOneOrThrow([row], new Error('seedHeldDeposit: no finding')) };
  }

  async function statusOf(transactionId: string) {
    const [row] = await db.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, transactionId));
    return row?.status;
  }

  const holdingPolicy = (reason: string | null): DepositHoldPolicy => ({
    holdReason: vi.fn(async () => reason),
  });

  async function reviewOf(transactionId: string) {
    const [row] = await db.drizzle.db
      .select({
        reviewedBy: walletTransaction.reviewedBy,
        reviewedAt: walletTransaction.reviewedAt,
      })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, transactionId));
    return row;
  }

  it('closes a held deposit refunded on chain with the refund tx hash and address as evidence', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const adminId = randomUUID();
    const { reconciliation, audit } = makeServices(listTransactionsReturning([]));

    const resolved = await reconciliation.resolveFinding(adminId, finding.id, refund());

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBe('refunded 1 BTC on chain in 0xrefund to bc1qplayer');
    expect(await statusOf(held.id)).toBe('refunded');
    expect((await reviewOf(held.id))?.reviewedBy).toBe(adminId);
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.reconciliation_finding.resolved',
        after: expect.objectContaining({
          outcome: 'refunded',
          refundedDepositId: held.id,
          refundAmount: '1',
          refundTxHash: '0xrefund',
          refundDestinationAddress: 'bc1qplayer',
        }),
      }),
    );
  });

  it('refuses to dismiss a held deposit, since the money is still in custody', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, {
        outcome: 'dismissed',
        note: 'refunded on chain',
      }),
    ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
    expect(await statusOf(held.id)).toBe('on_hold');
  });

  it('refuses to close a held deposit with a manual credit that bypasses the hold policy', async () => {
    const w = await seedWallet('BTC', '0');
    const { finding } = await seedHeldDeposit(w.id);
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, {
        outcome: 'credited',
        transactionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
  });

  it('releases a held deposit to the balance once the hold policy lets it in', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const adminId = randomUUID();
    const policy = holdingPolicy(null);
    const { reconciliation } = makeServices(listTransactionsReturning([]), { depositHold: policy });

    const resolved = await reconciliation.resolveFinding(adminId, finding.id, {
      outcome: 'released',
    });

    expect(resolved.status).toBe('resolved');
    expect(await statusOf(held.id)).toBe('completed');
    expect(await reviewOf(held.id)).toMatchObject({
      reviewedBy: adminId,
      reviewedAt: expect.any(Date),
    });
    expect(await balanceOf(w.id)).toBe('1.000000000000000000');
    expect(policy.holdReason).toHaveBeenCalledWith(expect.anything(), {
      userId: w.userId,
      amount: '1.000000000000000000',
      currency: 'BTC',
    });
  });

  it('refuses to release a held deposit while the player is still restricted', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      depositHold: holdingPolicy('rg_restricted'),
    });

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'released' }),
    ).rejects.toBeInstanceOf(DepositStillHeldError);
    expect(await statusOf(held.id)).toBe('on_hold');
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect((await findingRows())[0]?.status).toBe('open');
  });

  it('refuses to release a held deposit when no hold policy is bound to re-check it', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const { reconciliation } = makeServices(listTransactionsReturning([]));

    await expect(
      reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'released' }),
    ).rejects.toBeInstanceOf(DepositStillHeldError);
    expect(await statusOf(held.id)).toBe('on_hold');
    expect(await balanceOf(w.id)).toBe('0.000000000000000000');
    expect((await findingRows())[0]?.status).toBe('open');
  });

  it('stamps a released deposit with the database clock, the one the limit window reads', async () => {
    const w = await seedWallet('BTC', '0');
    const { held, finding } = await seedHeldDeposit(w.id);
    const { reconciliation } = makeServices(listTransactionsReturning([]), {
      depositHold: holdingPolicy(null),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    try {
      await reconciliation.resolveFinding(randomUUID(), finding.id, { outcome: 'released' });
    } finally {
      vi.useRealTimers();
    }

    expect((await reviewOf(held.id))?.reviewedAt?.getUTCFullYear()).toBeGreaterThan(2001);
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
