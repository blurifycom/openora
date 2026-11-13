import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  Container,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  DEFAULT_PAYMENT_PROVIDER,
  type PaymentAdapter,
  type PlatformConfig,
  type PlayEligibilityPort,
  type WalletReconciliationFindingKind,
} from '@openora/core/contracts';
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
import { migrate as promoMigrate } from '@openora/core/promo/migrate/bonus';
import { promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
import bonusPlugin from '@openora/core/promo/plugins/bonus';
import {
  wallet,
  walletBalance,
  walletBalanceBaseline,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
  type Wallet,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';
import { ReconciliationService } from '../service/reconciliation.service.js';
import { parseLedgerPairKey } from '../service/ledger-invariant.service.js';
import { WalletReconciliationFindingSchema } from '../contract/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, promoMigrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletJobRun}, ${walletReconciliationFinding}, ${walletBalanceBaseline}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

const playEligibility = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});
const commands = new WalletCommandsService(playEligibility, makeAuditWriter());

function makeReconciliation({
  batchSize = 200,
  audit = makeAuditWriter(),
  events = makeEventBus(),
}: {
  batchSize?: number;
  audit?: ReturnType<typeof makeAuditWriter>;
  events?: ReturnType<typeof makeEventBus>;
} = {}) {
  const payment = mock<PaymentAdapter>({});
  const paymentProviders = makePaymentProviderRegistry({ adapter: payment });
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
    events,
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

async function findings(kind: WalletReconciliationFindingKind) {
  return db.drizzle.db
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.kind, kind))
    .orderBy(walletReconciliationFinding.createdAt);
}

const breaches = () => findings('ledger_invariant_breach');

async function baselines(walletId: string) {
  return db.drizzle.db
    .select()
    .from(walletBalanceBaseline)
    .where(eq(walletBalanceBaseline.walletId, walletId))
    .orderBy(walletBalanceBaseline.asOf, walletBalanceBaseline.createdAt);
}

const handEdit = (walletId: string, delta: string) =>
  db.drizzle.db.execute(
    sql`update wallet_balance set amount = amount + ${delta}::numeric where wallet_id = ${walletId}`,
  );

const ADMIN_ID = randomUUID();

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

  /** A failed withdrawal whose `unknown_at_provider` finding was resolved by a manual credit. */
  async function settleFailedWithdrawalByHand({
    creditWalletId,
    vendorRefAfterFiling = false,
  }: { creditWalletId?: Wallet['id']; vendorRefAfterFiling?: boolean } = {}) {
    // The withdrawal took 40 and never gave it back; the manual credit returns it to its wallet.
    const w = await seedWallet(creditWalletId ? '960' : '1000', [
      { type: 'deposit', amount: '1000', status: 'completed', balanceAfter: '1000' },
      { type: 'withdrawal', amount: '40', status: 'failed', balanceAfter: '960' },
    ]);
    const withdrawal = findOneOrThrow(
      await db.drizzle.db
        .select({ id: walletTransaction.id })
        .from(walletTransaction)
        .where(and(eq(walletTransaction.walletId, w.id), eq(walletTransaction.type, 'withdrawal'))),
      new Error('withdrawal: no row'),
    );
    const manual = findOneOrThrow(
      await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId: creditWalletId ?? w.id,
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
      providerName: DEFAULT_PAYMENT_PROVIDER,
      kind: 'unknown_at_provider',
      currency: 'USD',
      externalId: withdrawal.id,
      transactionId: manual.id,
      status: 'resolved',
    });
    if (vendorRefAfterFiling) {
      await db.drizzle.db
        .update(walletTransaction)
        .set({ providerRefId: randomUUID() })
        .where(eq(walletTransaction.id, withdrawal.id));
    }
    return w;
  }

  it('keeps a hand-settled failed withdrawal debited, since its manual credit returned the money', async () => {
    await settleFailedWithdrawalByHand();

    await run(makeReconciliation());

    expect(await breaches()).toHaveLength(0);
  });

  it('still finds a hand settlement filed under the withdrawal id once a vendor reference lands', async () => {
    await settleFailedWithdrawalByHand({ vendorRefAfterFiling: true });

    await run(makeReconciliation());

    expect(await breaches()).toHaveLength(0);
  });

  it('does not count a manual credit to another wallet as settling the withdrawal', async () => {
    const other = await seedWallet('40');
    const w = await settleFailedWithdrawalByHand({ creditWalletId: other.id });

    await run(makeReconciliation());

    const filed = await breaches();
    expect(filed.map((f) => parseLedgerPairKey(f.externalId)?.walletId)).toEqual([w.id]);
    expect(Number(filed[0]?.amount)).toBe(40);
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

    const svc = makeReconciliation();
    const summary = await run(svc);
    await run(svc);

    expect(summary?.summary).toMatchObject({
      pairsChecked: 2,
      needsBaseline: 1,
      balanceBreaches: 0,
    });
    expect(await breaches()).toHaveLength(0);
    // Filed once per pair, however many runs find it still unchecked.
    const unchecked = await findings('ledger_invariant_unchecked');
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toMatchObject({ providerName: 'ledger', currency: 'USD', amount: null });
    const listed = await svc.listFindings({
      page: 1,
      limit: 20,
      kind: 'ledger_invariant_unchecked',
    });
    expect(WalletReconciliationFindingSchema.array().parse(listed.items)).toHaveLength(1);
  });

  it('files a page of unchecked pairs with their audit or not at all, and audits each once', async () => {
    await legacyWallet();
    await legacyWallet();
    const audit = makeAuditWriter();
    const refuse = async (entry: { action: string }) => {
      if (entry.action === 'wallet.reconciliation_finding.recorded') {
        throw new Error('audit store down');
      }
    };
    audit.record.mockImplementation(refuse);
    audit.recordInTransaction.mockImplementation((_txn, entry) => refuse(entry));
    const svc = makeReconciliation({ audit });

    await expect(svc.runLedgerInvariant(randomUUID())).rejects.toThrow('audit store down');
    expect(await findings('ledger_invariant_unchecked')).toHaveLength(0);

    audit.record.mockReset();
    audit.recordInTransaction.mockReset();
    await run(svc);
    await run(svc);
    const recorded = [
      ...audit.record.mock.calls.map(([entry]) => entry),
      ...audit.recordInTransaction.mock.calls.map(([, entry]) => entry),
    ].filter((entry) => entry.action === 'wallet.reconciliation_finding.recorded');
    expect(await findings('ledger_invariant_unchecked')).toHaveLength(2);
    expect(recorded).toHaveLength(2);
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

    const [backfilled, advanced] = await baselines(w.id);
    expect(backfilled?.asOf.getTime()).toBeLessThan(hoursAgo(24).getTime());
    expect(summary?.summary).toMatchObject({ balanceBreaches: 0, baselinesAdvanced: 1 });
    // The settled withdrawal now lies before the cut, so the clean check moves the baseline over it.
    expect(Number(advanced?.amount)).toBe(300);
    expect(advanced?.asOf.getTime()).toBeGreaterThan(hoursAgo(24).getTime());
    expect(await breaches()).toHaveLength(0);
  });
});

describe('rolling baselines and their repair (real PG)', () => {
  it('moves the baseline on after a clean check, so an error that comes back is filed again', async () => {
    const w = await fundedWallet('100');
    const svc = makeReconciliation();

    await handEdit(w.id, '7');
    await run(svc);
    await handEdit(w.id, '-7');
    const clean = await run(svc);
    await handEdit(w.id, '7');
    const again = await run(svc);
    const settled = await run(svc);

    expect(clean?.summary).toMatchObject({ balanceBreaches: 0, baselinesAdvanced: 1 });
    // Priced from the ledger: the deposit sits after the cut, so nothing is absorbed yet.
    const [baseline] = await baselines(w.id);
    expect(Number(baseline?.amount)).toBe(0);
    expect(baseline?.runId).not.toBeNull();
    expect(again?.summary).toMatchObject({ balanceBreaches: 1, newBreaches: 1 });
    expect(settled?.summary).toMatchObject({ balanceBreaches: 1, newBreaches: 0 });
    const found = await breaches();
    expect(found.map((f) => [f.status, Number(f.amount)])).toEqual([
      ['open', 7],
      ['open', 7],
    ]);
    expect(found[1]?.externalId).toContain(`:${baseline?.id}:`);
  });

  it('finds a breach filed under a baseline by the key the scan builds in SQL', async () => {
    const w = await seedWallet('100', [
      {
        type: 'deposit',
        amount: '100',
        status: 'completed',
        balanceAfter: '100',
        createdAt: hoursAgo(2),
      },
    ]);
    const svc = makeReconciliation();
    await run(svc);
    const [baseline] = await baselines(w.id);
    await handEdit(w.id, '7');
    await run(svc);
    await handEdit(w.id, '-7');

    // Nothing settled since the baseline, so only the breach filed under it moves it on.
    const repaired = await run(svc);

    const found = await breaches();
    expect(found).toHaveLength(1);
    expect(found[0]?.externalId).toContain(`:${baseline?.id}:`);
    expect(repaired?.summary).toMatchObject({ balanceBreaches: 0, baselinesAdvanced: 1 });
  });

  it('keeps every baseline as written: no update or delete reaches the table', async () => {
    const w = await fundedWallet('100');
    await handEdit(w.id, '7');
    await run(makeReconciliation());
    await handEdit(w.id, '-7');
    await run(makeReconciliation());
    expect(await baselines(w.id)).toHaveLength(1);
    const appendOnly = {
      cause: expect.objectContaining({ message: expect.stringContaining('append-only') }),
    };

    await expect(
      db.drizzle.db.execute(
        sql`update wallet_balance_baseline set amount = amount + 1 where wallet_id = ${w.id}`,
      ),
    ).rejects.toMatchObject(appendOnly);
    await expect(
      db.drizzle.db.execute(sql`delete from wallet_balance_baseline where wallet_id = ${w.id}`),
    ).rejects.toMatchObject(appendOnly);
    expect(await baselines(w.id)).toHaveLength(1);
  });

  it('dismisses a breach only once its pair checks clean, never credits one, and files its return', async () => {
    const w = await fundedWallet('100');
    const audit = makeAuditWriter();
    const svc = makeReconciliation({ audit });
    await handEdit(w.id, '7');
    await run(svc);
    const [breach] = await breaches();
    if (!breach) {
      throw new Error('no breach filed');
    }
    const dismiss = { outcome: 'dismissed', note: 'the edit was reverted by hand' } as const;

    await expect(svc.resolveFinding(ADMIN_ID, breach.id, dismiss)).rejects.toMatchObject({
      data: { reason: 'pair_not_clean' },
    });
    await expect(
      svc.resolveFinding(ADMIN_ID, breach.id, { outcome: 'credited', transactionId: randomUUID() }),
    ).rejects.toMatchObject({ data: { reason: 'outcome_not_allowed_for_kind' } });
    await handEdit(w.id, '-7');
    const dismissed = await svc.resolveFinding(ADMIN_ID, breach.id, dismiss);
    // The same error coming back before any run checks the pair again is still a new finding.
    await handEdit(w.id, '7');
    const back = await run(svc);

    expect(dismissed).toMatchObject({ status: 'resolved' });
    expect(back?.summary).toMatchObject({ balanceBreaches: 1, newBreaches: 1 });
    const [baseline] = await baselines(w.id);
    expect(baseline).toMatchObject({ findingId: breach.id });
  });

  it('keeps an unchecked pair open to neither dismissal nor credit, and closes it once a run baselines it', async () => {
    const w = await seedWallet('300', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
    ]);
    const audit = makeAuditWriter();
    const svc = makeReconciliation({ audit });
    await run(svc);
    const [unchecked] = await findings('ledger_invariant_unchecked');
    if (!unchecked) {
      throw new Error('no unchecked finding filed');
    }

    await expect(
      svc.resolveFinding(ADMIN_ID, unchecked.id, { outcome: 'dismissed', note: 'looks fine' }),
    ).rejects.toMatchObject({ data: { reason: 'pair_not_clean' } });
    await expect(
      svc.resolveFinding(ADMIN_ID, unchecked.id, {
        outcome: 'credited',
        transactionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ data: { reason: 'outcome_not_allowed_for_kind' } });
    await run(svc, true);

    const [closed] = await findings('ledger_invariant_unchecked');
    expect(closed).toMatchObject({ status: 'resolved', resolvedBy: null });
    expect(await baselines(w.id)).toHaveLength(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.reconciliation_finding.resolved',
        resourceId: unchecked.id,
        after: expect.objectContaining({ status: 'resolved', outcome: 'baselined' }),
      }),
    );
  });

  it('absorbs settled rows into the baseline from the ledger, never from the balance', async () => {
    const w = await seedWallet('70', [
      {
        type: 'deposit',
        amount: '100',
        status: 'completed',
        balanceAfter: '100',
        createdAt: hoursAgo(5),
      },
      {
        type: 'bet',
        amount: '30',
        status: 'completed',
        direction: 'debit',
        balanceAfter: '70',
        realShare: '30',
        createdAt: hoursAgo(4),
      },
    ]);
    const svc = makeReconciliation();

    const first = await run(svc);
    const second = await run(svc);

    expect(first?.summary).toMatchObject({ balanceBreaches: 0, baselinesAdvanced: 1 });
    // Nothing new before the cut since: no second row.
    expect(second?.summary).toMatchObject({ baselinesAdvanced: 0 });
    const history = await baselines(w.id);
    expect(history).toHaveLength(1);
    expect(Number(history[0]?.amount)).toBe(70);
  });

  it('re-baselines a breached wallet at its balance for a super admin, recording old and new', async () => {
    const w = await fundedWallet('100');
    const audit = makeAuditWriter();
    const svc = makeReconciliation({ audit });
    await handEdit(w.id, '7');
    await run(svc);
    const [breach] = await breaches();
    if (!breach) {
      throw new Error('no breach filed');
    }

    const resolved = await svc.resolveFinding(ADMIN_ID, breach.id, {
      outcome: 'rebaselined',
      note: 'player was owed 7 from a support case',
    });
    const after = await run(svc);
    await handEdit(w.id, '7');
    const retamper = await run(svc);

    expect(resolved).toMatchObject({ status: 'resolved' });
    const [baseline] = await baselines(w.id);
    expect(baseline).toMatchObject({ findingId: breach.id, runId: null });
    // 107 held, less the 100 deposit after the cut.
    expect(Number(baseline?.amount)).toBe(7);
    const resolvedAudit = audit.recordInTransaction.mock.calls
      .map(([, entry]) => entry)
      .find((entry) => entry.action === 'wallet.reconciliation_finding.resolved');
    expect(resolvedAudit?.after).toMatchObject({
      outcome: 'rebaselined',
      baseline: { before: null, after: { id: baseline?.id } },
    });
    expect(after?.summary).toMatchObject({ balanceBreaches: 0 });
    expect(retamper?.summary).toMatchObject({ balanceBreaches: 1, newBreaches: 1 });
  });

  it('refuses to re-baseline a breach whose drift grew since it was filed', async () => {
    const w = await fundedWallet('100');
    const svc = makeReconciliation();
    await handEdit(w.id, '5');
    await run(svc);
    const [breach] = await breaches();
    if (!breach) {
      throw new Error('no breach filed');
    }
    await handEdit(w.id, '7');

    await expect(
      svc.resolveFinding(ADMIN_ID, breach.id, { outcome: 'rebaselined', note: 'owed 5' }),
    ).rejects.toMatchObject({ data: { reason: 'drift_changed' } });
    expect(await baselines(w.id)).toHaveLength(0);
  });

  it('refuses to re-baseline a breach measured from a baseline no longer in force', async () => {
    const w = await fundedWallet('100');
    const svc = makeReconciliation();
    await handEdit(w.id, '7');
    await run(svc);
    const [breach] = await breaches();
    if (!breach) {
      throw new Error('no breach filed');
    }
    await handEdit(w.id, '-7');
    await run(svc);
    await handEdit(w.id, '7');

    await expect(
      svc.resolveFinding(ADMIN_ID, breach.id, { outcome: 'rebaselined', note: 'owed 7' }),
    ).rejects.toMatchObject({ data: { reason: 'baseline_moved' } });
    expect(await baselines(w.id)).toHaveLength(1);
  });

  it('refuses to re-baseline a flagged backfill whose drift changed since it was filed', async () => {
    const w = await seedWallet('270', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
      {
        type: 'bet',
        amount: '40',
        status: 'completed',
        direction: 'debit',
        realShare: '40',
        balanceAfter: '260',
        createdAt: hoursAgo(30),
      },
    ]);
    const svc = makeReconciliation();
    await run(svc, true);
    const flagged = (await findings('ledger_invariant_unchecked')).find((f) =>
      f.externalId?.includes(':backfill:'),
    );
    if (!flagged) {
      throw new Error('no backfill mismatch filed');
    }
    await handEdit(w.id, '3');

    await expect(
      svc.resolveFinding(ADMIN_ID, flagged.id, { outcome: 'rebaselined', note: 'owed 10' }),
    ).rejects.toMatchObject({ data: { reason: 'drift_changed' } });
    expect(await baselines(w.id)).toHaveLength(0);

    await handEdit(w.id, '-3');
    await svc.resolveFinding(ADMIN_ID, flagged.id, { outcome: 'rebaselined', note: 'owed 10' });
    expect(await baselines(w.id)).toHaveLength(1);
  });

  it('refuses to re-baseline an unchecked pair filed under a baseline no longer in force', async () => {
    const w = await seedWallet('300', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
    ]);
    const svc = makeReconciliation();
    await run(svc);
    const [unchecked] = await findings('ledger_invariant_unchecked');
    if (!unchecked) {
      throw new Error('no unchecked finding filed');
    }
    await db.drizzle.db
      .insert(walletBalanceBaseline)
      .values({ walletId: w.id, currency: 'USD', amount: '300', asOf: hoursAgo(47) });

    await expect(
      svc.resolveFinding(ADMIN_ID, unchecked.id, { outcome: 'rebaselined', note: 'confirmed' }),
    ).rejects.toMatchObject({ data: { reason: 'baseline_moved' } });
    expect(await baselines(w.id)).toHaveLength(1);
  });

  it('records what the stamped ledger says beside a re-baselined unchecked pair', async () => {
    // Its balance was edited by 10 after the bet stamped 260, before anything priced it.
    const w = await seedWallet('270', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
      {
        type: 'bet',
        amount: '40',
        status: 'completed',
        direction: 'debit',
        realShare: '40',
        balanceAfter: '260',
        createdAt: hoursAgo(30),
      },
    ]);
    const audit = makeAuditWriter();
    const svc = makeReconciliation({ audit });
    await run(svc);
    const [unchecked] = await findings('ledger_invariant_unchecked');
    if (!unchecked) {
      throw new Error('no unchecked finding filed');
    }

    await svc.resolveFinding(ADMIN_ID, unchecked.id, {
      outcome: 'rebaselined',
      note: 'balance confirmed against the old system',
    });

    const resolvedAudit = audit.recordInTransaction.mock.calls
      .map(([, entry]) => entry)
      .find((entry) => entry.action === 'wallet.reconciliation_finding.resolved');
    const baseline = z
      .object({ balance: z.string(), estimate: z.string(), mismatch: z.string() })
      .parse((resolvedAudit?.after as { baseline?: unknown } | undefined)?.baseline);
    expect([baseline.balance, baseline.estimate, baseline.mismatch].map(Number)).toEqual([
      270, 260, 10,
    ]);
    expect(await baselines(w.id)).toHaveLength(1);
  });

  it('refuses to re-baseline a finding that is not about a ledger', async () => {
    const svc = makeReconciliation();
    const finding = findOneOrThrow(
      await db.drizzle.db
        .insert(walletReconciliationFinding)
        .values({
          runId: randomUUID(),
          providerName: 'mock',
          kind: 'stuck_sweep',
          externalId: randomUUID(),
        })
        .returning(),
      new Error('finding: no row'),
    );

    await expect(
      svc.resolveFinding(ADMIN_ID, finding.id, { outcome: 'rebaselined', note: 'n' }),
    ).rejects.toMatchObject({ name: 'ReconciliationOutcomeNotAllowedError' });
  });

  it('refuses a backfill that disagrees with the balance the ledger last stamped, and files it unchecked', async () => {
    const legacy = (balance: string, betBalanceAfter: string) =>
      seedWallet(balance, [
        {
          type: 'deposit',
          amount: '300',
          status: 'completed',
          balanceAfter: null,
          createdAt: hoursAgo(48),
        },
        {
          type: 'bet',
          amount: '40',
          status: 'completed',
          direction: 'debit',
          realShare: '40',
          balanceAfter: betBalanceAfter,
          createdAt: hoursAgo(30),
        },
      ]);
    const agrees = await legacy('260', '260');
    // The balance was edited by 10 before the backfill: it must not become the new zero.
    const edited = await legacy('270', '260');
    const events = makeEventBus();
    const svc = makeReconciliation({ events });

    const summary = await run(svc, true);

    expect(summary?.summary).toMatchObject({
      baselinesInserted: 1,
      baselineMismatches: 1,
      needsBaseline: 1,
      newBreaches: 0,
    });
    expect(await baselines(agrees.id)).toHaveLength(1);
    expect(await baselines(edited.id)).toHaveLength(0);
    // Stamps written as the row was created, not as it completed, may order wrong: an estimate
    // off them is a reason to look, not proof money is missing.
    expect(await breaches()).toHaveLength(0);
    const mismatch = (await findings('ledger_invariant_unchecked')).find((f) =>
      f.externalId?.includes(':backfill:'),
    );
    expect(mismatch?.externalId).toBe(`wallet:${edited.id}:USD:backfill:10.000000000000000000`);
    expect(mismatch?.detail).toContain('at 270');
    expect(mismatch?.detail).toContain('to 260');
    expect(events.emitInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      'wallet.reconciliation.alert',
      expect.anything(),
    );
  });

  it('holds a pair whose backfill was flagged, even once a later stamp agrees with its balance', async () => {
    const w = await seedWallet('270', [
      {
        type: 'deposit',
        amount: '300',
        status: 'completed',
        balanceAfter: null,
        createdAt: hoursAgo(48),
      },
      {
        type: 'bet',
        amount: '40',
        status: 'completed',
        direction: 'debit',
        realShare: '40',
        balanceAfter: '260',
        createdAt: hoursAgo(30),
      },
    ]);
    const svc = makeReconciliation();
    await run(svc, true);
    // A bet stamped off the edited balance: the stamps now carry the +10 forward as if it were real.
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      currency: 'USD',
      type: 'bet',
      amount: '5',
      status: 'completed',
      direction: 'debit',
      realShare: '5',
      balanceAfter: '265',
      createdAt: hoursAgo(2),
    });
    await handEdit(w.id, '-5');

    const second = await run(svc, true);

    expect(second?.summary).toMatchObject({ baselinesInserted: 0, needsBaseline: 1 });
    expect(await baselines(w.id)).toHaveLength(0);
    const unchecked = await findings('ledger_invariant_unchecked');
    expect(unchecked.map((f) => [f.externalId, f.status])).toEqual(
      expect.arrayContaining([[`wallet:${w.id}:USD:backfill:10.000000000000000000`, 'open']]),
    );
    expect(unchecked.every((f) => f.status === 'open')).toBe(true);

    // A super admin accepting the plain unchecked pair baselines it; the flag stays for its own look.
    const plain = unchecked.find((f) => f.externalId === `wallet:${w.id}:USD:none`);
    if (!plain) {
      throw new Error('no plain unchecked finding filed');
    }
    await svc.resolveFinding(ADMIN_ID, plain.id, { outcome: 'rebaselined', note: 'confirmed' });
    await run(svc);
    const flagged = (await findings('ledger_invariant_unchecked')).find((f) =>
      f.externalId?.includes(':backfill:'),
    );
    expect(flagged?.status).toBe('open');
  });

  it('keeps the alert of a breach filed before the run failed', async () => {
    await handEdit((await fundedWallet('100')).id, '7');
    await handEdit((await fundedWallet('100')).id, '9');
    const audit = makeAuditWriter();
    const events = makeEventBus();
    let filed = 0;
    const failSecondFiling = async (entry: { action: string }) => {
      if (entry.action === 'wallet.reconciliation_finding.recorded' && ++filed === 2) {
        throw new Error('audit store down');
      }
    };
    audit.record.mockImplementation(failSecondFiling);
    audit.recordInTransaction.mockImplementation((_txn, entry) => failSecondFiling(entry));
    const svc = makeReconciliation({ batchSize: 1, audit, events });

    await expect(svc.runLedgerInvariant(randomUUID())).rejects.toThrow('audit store down');

    const alerts = events.emitInTransaction.mock.calls.filter(
      ([, topic]) => topic === 'wallet.reconciliation.alert',
    );
    expect(await breaches()).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('alerts once on a new breach, below the open-findings threshold, and not again on a rerun', async () => {
    const w = await fundedWallet('100');
    const events = makeEventBus();
    const svc = makeReconciliation({ events });
    await handEdit(w.id, '7');

    await run(svc);
    await run(svc);

    const alerts = events.emitInTransaction.mock.calls.filter(
      ([, topic]) => topic === 'wallet.reconciliation.alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.[2]).toMatchObject({ openFindings: 1, threshold: 0 });
  });
});

describe('ledger invariant run hygiene (real PG)', () => {
  async function inFlight(minutesAgo: number) {
    await db.drizzle.db.insert(walletJobRun).values({
      jobName: 'wallet-ledger-invariant',
      runId: randomUUID(),
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
  }

  it('waits out a ledger run longer than the vendor diff would, then takes it over', async () => {
    const svc = makeReconciliation();
    await inFlight(45);
    expect(await svc.runLedgerInvariant(randomUUID())).toBeNull();

    await db.drizzle.db.execute(sql`TRUNCATE ${walletJobRun}`);
    await inFlight(300);
    expect(await svc.runLedgerInvariant(randomUUID())).not.toBeNull();
  });

  it('audits a backfill that could not run because another run holds the slot', async () => {
    const audit = makeAuditWriter();
    const svc = makeReconciliation({ audit });
    await inFlight(1);

    await svc.runLedgerInvariant(randomUUID());
    expect(audit.record).not.toHaveBeenCalled();
    const runId = randomUUID();
    expect(await svc.runLedgerInvariant(runId, { backfillBaselines: true })).toBeNull();

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.ledger_invariant_run.skipped',
        resourceId: runId,
        after: expect.objectContaining({ backfillBaselines: true }),
      }),
    );
  });

  it('leaves a run taken over as stale abandoned when it finishes late', async () => {
    const w = await fundedWallet('100');
    await handEdit(w.id, '7');
    const audit = makeAuditWriter();
    // Another worker takes the run over while it files its finding.
    audit.recordInTransaction.mockImplementationOnce(async () => {
      await db.drizzle.db
        .update(walletJobRun)
        .set({ status: 'abandoned', finishedAt: new Date() })
        .where(eq(walletJobRun.status, 'running'));
    });
    const svc = makeReconciliation({ audit });

    const res = await svc.runLedgerInvariant(randomUUID());

    expect(res).not.toBeNull();
    const row = await summaryOf(res?.runId ?? '');
    expect(row?.status).toBe('abandoned');
    // The run that took it over reports; this one must not also claim it completed.
    expect(audit.recordInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.ledger_invariant_run.completed' }),
    );
  });
});

// The bonus module's own services, resolved the way the platform wires them.
function bootBonusModule() {
  const container = new Container<CoreTokenCatalog>();
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('bonus');
  bonusPlugin.register(registry);
  return container;
}

describe('bonus-split play through the real wagering engine (real PG)', () => {
  const bonus = bootBonusModule();
  const bonusCommands = new WalletCommandsService(playEligibility, makeAuditWriter(), {
    bonusWagering: bonus.get(BONUS_WAGERING),
  });
  const CASINO = { provider: 'dice', product: 'casino' } as const;

  async function grantBonus(userId: string, amount: string) {
    const profile = findOneOrThrow(
      await db.drizzle.db
        .insert(promoWeightProfile)
        .values({ name: `profile-${randomUUID()}` })
        .returning(),
      new Error('weight profile: no row'),
    );
    await db.drizzle.db.insert(promoWeight).values({
      profileId: profile.id,
      scope: 'default',
      scopeRef: null,
      contributionPercent: '100',
    });
    const outcome = await db.drizzle.db.transaction((txn) =>
      bonus.get(BONUS_GRANTS).grant(txn, {
        userId,
        currency: 'USD',
        amount,
        source: 'deposit',
        sourceRef: randomUUID(),
        actor: { type: 'system' },
        terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId: profile.id },
      }),
    );
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }
  }

  it('prices a bonus-split bet, reversal and win and a correction to zero by their real parts', async () => {
    const w = await fundedWallet('20');
    await grantBonus(w.userId, '100');
    const roundOf = () => ({ providerName: 'dice', externalRoundId: randomUUID() });
    const first = roundOf();
    const second = roundOf();
    const leg = (round: typeof first) => ({ ...round, providerRefId: randomUUID() });
    const rowOf = async (id: string | undefined) =>
      findOneOrThrow(
        await db.drizzle.db
          .select()
          .from(walletTransaction)
          .where(eq(walletTransaction.id, id ?? randomUUID())),
        new Error('ledger row missing'),
      );
    const svc = makeReconciliation();

    // 20 real and 10 bonus, then the round rolled back: each balance gets its own part back.
    const bet = await db.drizzle.db.transaction((txn) =>
      bonusCommands.debit(txn, {
        userId: w.userId,
        amount: '30',
        type: 'bet',
        context: CASINO,
        providerRef: leg(first),
      }),
    );
    const reversal = await db.drizzle.db.transaction((txn) =>
      bonusCommands.credit(txn, {
        userId: w.userId,
        amount: '30',
        currency: 'USD',
        type: 'bet_reversal',
        providerRef: leg(first),
      }),
    );
    const afterSplit = await run(svc);
    // The provider takes the rollback back: the real balance is re-collected down to zero.
    const correction = await db.drizzle.db.transaction((txn) =>
      bonusCommands.correctionDebit(txn, {
        userId: w.userId,
        amount: '20',
        currency: 'USD',
        type: 'bet',
        providerRef: leg(first),
      }),
    );
    const afterCorrection = await run(svc);
    // A stake paid from bonus alone, and its win split between the two balances.
    await db.drizzle.db.transaction((txn) =>
      bonusCommands.debit(txn, {
        userId: w.userId,
        amount: '10',
        type: 'bet',
        context: CASINO,
        providerRef: leg(second),
      }),
    );
    const win = await db.drizzle.db.transaction((txn) =>
      bonusCommands.credit(txn, {
        userId: w.userId,
        amount: '45',
        currency: 'USD',
        type: 'win',
        providerRef: leg(second),
      }),
    );
    const afterWin = await run(svc);
    await handEdit(w.id, '3');
    const tampered = await run(svc);

    if (!bet.ok || !bet.moved || !reversal.ok || !reversal.moved || !win.ok || !win.moved) {
      throw new Error('a play command was refused or replayed');
    }
    expect(Number((await rowOf(bet.transactionId)).realShare)).toBe(20);
    expect(Number((await rowOf(reversal.transactionId)).realShare)).toBe(20);
    expect(Number((await rowOf(win.transactionId)).realShare)).toBeLessThan(45);
    expect(correction).toMatchObject({ moved: true });
    expect(Number(correction.collected)).toBe(20);
    expect(Number(correction.newBalance)).toBe(0);
    for (const summary of [afterSplit, afterCorrection, afterWin]) {
      expect(summary?.summary).toMatchObject({ needsBaseline: 0, balanceBreaches: 0 });
    }
    expect(tampered?.summary).toMatchObject({ needsBaseline: 0, balanceBreaches: 1 });
    expect((await breaches()).map((f) => Number(f.amount))).toEqual([3]);
  });
});
