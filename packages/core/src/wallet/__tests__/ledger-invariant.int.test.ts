import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import type { PaymentAdapter, PlatformConfig, PlayEligibilityPort } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeAuditWriter,
  makeEventBus,
  makeExchangeRateReader,
  makeIdentityReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletBalanceBaseline,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';
import { ReconciliationService } from '../service/reconciliation.service.js';
import { WalletReconciliationFindingSchema } from '../contract/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletJobRun}, ${walletReconciliationFinding}, ${walletBalanceBaseline}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

const commands = new WalletCommandsService(
  mock<PlayEligibilityPort>({
    isRestricted: vi.fn().mockResolvedValue(false),
    checkPlay: vi.fn().mockResolvedValue(null),
  }),
  makeAuditWriter(),
);

function makeReconciliation({ batchSize = 200 }: { batchSize?: number } = {}) {
  const payment = mock<PaymentAdapter>({});
  const paymentProviders = makePaymentProviderRegistry({ adapter: payment });
  const audit = makeAuditWriter();
  const platformConfig = mock<PlatformConfig>({
    wallet: {
      reconciliation: {
        cron: '0 * * * *',
        lookbackHours: 24,
        batchSize,
        stuckAfterMinutes: 60,
        staleRunAfterMinutes: 30,
        alertThreshold: 10,
      },
    },
  });
  const walletSvc = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
    platformConfig,
    rates: makeExchangeRateReader(),
  });
  return new ReconciliationService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    wallet: walletSvc,
    paymentProviders,
    audit,
    platformConfig,
  });
}

type LedgerRow = Partial<typeof walletTransaction.$inferInsert> &
  Pick<typeof walletTransaction.$inferInsert, 'type' | 'amount' | 'status'>;

/** A wallet whose ledger already holds `rows` and whose balance is `balance`, written as given. */
async function seedWallet(balance: string, rows: LedgerRow[] = []) {
  const w = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: w.id, currency: 'USD', amount: balance });
  for (const row of rows) {
    await db.drizzle.db
      .insert(walletTransaction)
      .values({ walletId: w.id, currency: 'USD', ...row });
  }
  return w;
}

/** The common case: one completed deposit the balance agrees with. */
function fundedWallet(amount = '1000') {
  return seedWallet(amount, [
    { type: 'deposit', amount, status: 'completed', balanceAfter: amount },
  ]);
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function summaryOf(runId: string) {
  const [row] = await db.drizzle.db
    .select({ summary: walletJobRun.summary, status: walletJobRun.status })
    .from(walletJobRun)
    .where(eq(walletJobRun.runId, runId));
  return row;
}

async function breaches() {
  return db.drizzle.db
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.kind, 'ledger_invariant_breach'));
}

async function run(svc: ReconciliationService, backfillBaselines = false) {
  const res = await svc.runLedgerInvariant(randomUUID(), { backfillBaselines });
  if (!res) {
    throw new Error('ledger invariant run was not claimed');
  }
  return summaryOf(res.runId);
}

describe('ledger invariant scan (real PG)', () => {
  it('raises no breach while bets and wins commit during the scan', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => fundedWallet()));
    // Small pages, so the scan spans many statements while play commits between them.
    const svc = makeReconciliation({ batchSize: 2 });
    let playing = true;
    const play = Promise.all(
      wallets.map(async (w) => {
        for (let i = 0; i < 15; i += 1) {
          await db.drizzle.db.transaction((txn) =>
            commands.debit(txn, { userId: w.userId, amount: '3.5', type: 'bet' }),
          );
          await db.drizzle.db.transaction((txn) =>
            commands.credit(txn, {
              userId: w.userId,
              amount: i % 3 === 0 ? '7.25' : '1',
              currency: 'USD',
              type: 'win',
            }),
          );
        }
      }),
    ).finally(() => {
      playing = false;
    });
    let scans = 0;
    while (playing || scans === 0) {
      await run(svc);
      scans += 1;
    }
    await play;
    const final = await run(svc);

    expect(scans).toBeGreaterThan(1);
    expect(final?.summary).toMatchObject({
      pairsChecked: 12,
      needsBaseline: 0,
      balanceBreaches: 0,
    });
    expect(await breaches()).toHaveLength(0);
  });

  it('prices only what moved: zero-amount loss, failed, cancelled and pending rows', async () => {
    const w = await seedWallet('925', [
      { type: 'deposit', amount: '1000', status: 'completed', balanceAfter: '1000' },
      // Never credited.
      { type: 'deposit', amount: '50', status: 'failed', balanceAfter: '1000' },
      { type: 'deposit', amount: '30', status: 'pending', balanceAfter: '1000' },
      // Debited at request, put back on failure, rejection and cancellation.
      { type: 'withdrawal', amount: '20', status: 'cancelled', balanceAfter: '980' },
      { type: 'withdrawal', amount: '10', status: 'failed', balanceAfter: '970' },
      { type: 'withdrawal', amount: '15', status: 'rejected', balanceAfter: '955' },
      // Still held: the debit stands.
      { type: 'withdrawal', amount: '5', status: 'pending', balanceAfter: '995' },
      { type: 'swap_out', amount: '40', status: 'failed', balanceAfter: '955' },
      { type: 'swap_out', amount: '20', status: 'processing', balanceAfter: '975' },
      // A non-completed generic row never moved the balance.
      {
        type: 'manual_credit',
        amount: '500',
        status: 'failed',
        direction: 'credit',
        balanceAfter: '1475',
      },
      {
        type: 'manual_debit',
        amount: '50',
        status: 'completed',
        direction: 'debit',
        balanceAfter: '925',
      },
    ]);
    await db.drizzle.db.transaction((txn) =>
      commands.debit(txn, { userId: w.userId, amount: '0', type: 'loss' }),
    );

    const summary = await run(makeReconciliation());

    // 1000 - 5 (pending withdrawal) - 20 (open swap) - 50 (manual debit) = 925.
    expect(summary?.summary).toMatchObject({ needsBaseline: 0, balanceBreaches: 0 });
    expect(await breaches()).toHaveLength(0);
  });

  it('refuses negative and zero stakes and wins at the command, leaving the ledger whole', async () => {
    const w = await fundedWallet('100');
    await expect(
      db.drizzle.db.transaction((txn) =>
        commands.debit(txn, { userId: w.userId, amount: '-5', type: 'bet' }),
      ),
    ).rejects.toMatchObject({ name: 'WalletCommandAmountError' });
    await expect(
      db.drizzle.db.transaction((txn) =>
        commands.credit(txn, { userId: w.userId, amount: '0', currency: 'USD', type: 'win' }),
      ),
    ).rejects.toMatchObject({ name: 'WalletCommandAmountError' });

    const summary = await run(makeReconciliation());

    expect(summary?.summary).toMatchObject({ balanceBreaches: 0 });
    expect(await breaches()).toHaveLength(0);
  });

  it('keeps a hand-settled failed withdrawal debited, since its manual credit returned the money', async () => {
    const w = await seedWallet('1000', [
      { type: 'deposit', amount: '1000', status: 'completed', balanceAfter: '1000' },
      { type: 'withdrawal', amount: '40', status: 'failed', balanceAfter: '960' },
    ]);
    const [withdrawal] = await db.drizzle.db
      .select({ id: walletTransaction.id })
      .from(walletTransaction)
      .where(eq(walletTransaction.type, 'withdrawal'));
    const manual = findOneOrThrow(
      await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId: w.id,
          currency: 'USD',
          type: 'manual_credit',
          amount: '40',
          status: 'completed',
          direction: 'credit',
          balanceAfter: '1000',
        })
        .returning(),
      new Error('manual credit: no row'),
    );
    await db.drizzle.db.insert(walletReconciliationFinding).values({
      runId: randomUUID(),
      providerName: 'mock',
      kind: 'unknown_at_provider',
      currency: 'USD',
      externalId: withdrawal?.id,
      transactionId: manual.id,
      status: 'resolved',
    });

    await run(makeReconciliation());

    expect(await breaches()).toHaveLength(0);
  });

  it('files one finding for a balance edited by hand, and a rerun or more play does not duplicate it', async () => {
    const w = await fundedWallet('100');
    await db.drizzle.db.execute(
      sql`update wallet_balance set amount = amount + 7 where wallet_id = ${w.id}`,
    );
    const svc = makeReconciliation();

    const first = await run(svc);
    await db.drizzle.db.transaction((txn) =>
      commands.debit(txn, { userId: w.userId, amount: '2', type: 'bet' }),
    );
    await run(svc);
    await run(svc);

    expect(first?.summary).toMatchObject({ balanceBreaches: 1 });
    const found = await breaches();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ providerName: 'ledger', currency: 'USD', status: 'open' });
    expect(Number(found[0]?.amount)).toBe(7);
  });

  it('files a second finding when the drift changes again', async () => {
    const w = await fundedWallet('100');
    const svc = makeReconciliation();
    await db.drizzle.db.execute(
      sql`update wallet_balance set amount = amount + 7 where wallet_id = ${w.id}`,
    );
    await run(svc);
    await db.drizzle.db.execute(
      sql`update wallet_balance set amount = amount + 1 where wallet_id = ${w.id}`,
    );
    await run(svc);

    expect((await breaches()).map((f) => Number(f.amount)).sort()).toEqual([7, 8]);
  });
});

describe('legacy rows and the baseline backfill (real PG)', () => {
  /** A wallet funded before rows recorded `balance_after`. */
  function legacyWallet(createdAt = hoursAgo(48), amount = '300') {
    return seedWallet(amount, [
      { type: 'deposit', amount, status: 'completed', balanceAfter: null, createdAt },
    ]);
  }

  it('reports a legacy wallet as needing a baseline, never as a breach', async () => {
    await legacyWallet();
    // A zero-amount legacy row moved nothing, so it needs no baseline.
    await seedWallet('0', [
      { type: 'loss', amount: '0', status: 'completed', direction: 'debit', balanceAfter: null },
    ]);

    const summary = await run(makeReconciliation());

    expect(summary?.summary).toMatchObject({
      pairsChecked: 2,
      needsBaseline: 1,
      balanceBreaches: 0,
    });
    expect(await breaches()).toHaveLength(0);
  });

  it('baselines a legacy wallet, then checks play after it, and a rerun of the backfill is a no-op', async () => {
    const w = await legacyWallet();
    const healthy = await fundedWallet('50');
    const svc = makeReconciliation();

    const first = await run(svc, true);
    const [baseline] = await db.drizzle.db.select().from(walletBalanceBaseline);
    await db.drizzle.db.transaction((txn) =>
      commands.debit(txn, { userId: w.userId, amount: '25', type: 'bet' }),
    );
    await db.drizzle.db.transaction((txn) =>
      commands.credit(txn, { userId: w.userId, amount: '60', currency: 'USD', type: 'win' }),
    );
    const second = await run(svc, true);
    const after = await db.drizzle.db.select().from(walletBalanceBaseline);

    expect(first?.summary).toMatchObject({
      baselinesInserted: 1,
      baselinesSkipped: 0,
      needsBaseline: 0,
      balanceBreaches: 0,
    });
    expect(baseline).toMatchObject({ walletId: w.id, currency: 'USD' });
    expect(Number(baseline?.amount)).toBe(300);
    expect(second?.summary).toMatchObject({ baselinesInserted: 0, balanceBreaches: 0 });
    expect(after).toEqual([baseline]);
    expect(after.some((b) => b.walletId === healthy.id)).toBe(false);
    expect(await breaches()).toHaveLength(0);
  });

  it('still catches a balance edited by hand after the baseline', async () => {
    const w = await legacyWallet();
    const svc = makeReconciliation();
    await run(svc, true);
    await db.drizzle.db.execute(
      sql`update wallet_balance set amount = amount - 0.5 where wallet_id = ${w.id}`,
    );

    await run(svc);

    const found = await breaches();
    expect(found).toHaveLength(1);
    expect(Number(found[0]?.amount)).toBe(0.5);
    expect(found[0]?.detail).toContain('short by 0.5');
    // The admin list serves it through the contract's schema, whose amount is non-negative.
    const listed = await svc.listFindings({ page: 1, limit: 20, kind: 'ledger_invariant_breach' });
    expect(WalletReconciliationFindingSchema.array().parse(listed.items)).toHaveLength(1);
  });

  it('prices a correction that re-collects a stake down to zero, so a later hand edit is a breach', async () => {
    const w = await legacyWallet(hoursAgo(48), '100');
    const svc = makeReconciliation();
    await run(svc, true);
    const round = { providerName: 'dice', externalRoundId: randomUUID() };
    const leg = () => ({ ...round, providerRefId: randomUUID() });
    await db.drizzle.db.transaction(async (txn) => {
      await commands.debit(txn, {
        userId: w.userId,
        amount: '40',
        type: 'bet',
        providerRef: leg(),
      });
      await commands.credit(txn, {
        userId: w.userId,
        amount: '40',
        currency: 'USD',
        type: 'bet_reversal',
        providerRef: leg(),
      });
      await commands.debit(txn, {
        userId: w.userId,
        amount: '70',
        type: 'bet',
        providerRef: {
          providerName: 'dice',
          providerRefId: randomUUID(),
          externalRoundId: randomUUID(),
        },
      });
    });
    const correction = await db.drizzle.db.transaction((txn) =>
      commands.correctionDebit(txn, {
        userId: w.userId,
        amount: '40',
        currency: 'USD',
        type: 'bet',
        providerRef: leg(),
      }),
    );
    await db.drizzle.db.execute(
      sql`update wallet_balance set amount = amount + 7 where wallet_id = ${w.id}`,
    );

    const summary = await run(svc);

    expect(Number(correction.collected)).toBe(30);
    expect(Number(correction.newBalance)).toBe(0);
    expect(summary?.summary).toMatchObject({ needsBaseline: 0, balanceBreaches: 1 });
    const found = await breaches();
    expect(found).toHaveLength(1);
    expect(Number(found[0]?.amount)).toBe(7);
  });

  it('skips a wallet whose legacy row is too recent to baseline, and keeps it as needing one', async () => {
    await legacyWallet(new Date());

    const summary = await run(makeReconciliation(), true);

    expect(summary?.summary).toMatchObject({
      baselinesInserted: 0,
      baselinesSkipped: 1,
      needsBaseline: 1,
    });
    expect(await db.drizzle.db.select().from(walletBalanceBaseline)).toHaveLength(0);
  });

  it('cuts the baseline before a row still in flight, so its later settlement is checked', async () => {
    const w = await seedWallet('280', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
      // Requested before the cut and still open: the baseline must not swallow it.
      {
        type: 'withdrawal',
        amount: '20',
        status: 'pending',
        balanceAfter: '280',
        createdAt: hoursAgo(24),
      },
    ]);
    const svc = makeReconciliation();
    await run(svc, true);
    // The withdrawal fails and is credited back, as finalizeFailedWithdrawal does.
    await db.drizzle.db.transaction(async (txn) => {
      await txn
        .update(walletTransaction)
        .set({ status: 'failed' })
        .where(eq(walletTransaction.type, 'withdrawal'));
      await txn.execute(
        sql`update wallet_balance set amount = amount + 20 where wallet_id = ${w.id}`,
      );
    });

    const summary = await run(svc);

    const [baseline] = await db.drizzle.db.select().from(walletBalanceBaseline);
    expect(baseline?.asOf.getTime()).toBeLessThan(hoursAgo(24).getTime());
    expect(summary?.summary).toMatchObject({ balanceBreaches: 0 });
    expect(await breaches()).toHaveLength(0);
  });
});
