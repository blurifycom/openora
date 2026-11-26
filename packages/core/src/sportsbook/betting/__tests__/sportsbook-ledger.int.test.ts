import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookPlayerDebt,
  sportsbookPlayerRestriction,
  sportsbookReconciliationFinding,
} from '../schema/index.js';
import {
  PROVIDER,
  ledgerPlayEligibility,
  walletBalance,
  applied,
  balanceOf,
  bootLedger,
  money,
  reserveArgs,
  seedBettor,
  sportsbookWalletRows,
  txId,
  type LedgerHarness,
} from '../../../testing/sportsbook-ledger-harness.js';

let h: LedgerHarness;

beforeAll(async () => {
  h = await bootLedger();
}, 120_000);

afterAll(() => h.testDb.drop());

const db = () => h.testDb.drizzle.db;

const betRows = (providerBetId: string) =>
  db().select().from(sportsbookBet).where(eq(sportsbookBet.providerBetId, providerBetId));

const txRows = (providerBetId: string) =>
  db()
    .select()
    .from(sportsbookBetTransaction)
    .where(eq(sportsbookBetTransaction.providerBetId, providerBetId));

async function placed(amount = '100', overrides: Parameters<typeof reserveArgs>[1] = {}) {
  const bettor = await seedBettor(h.testDb, amount);
  const args = reserveArgs(bettor.sessionId, overrides);
  const outcome = applied(await h.ledger.reserve(args));
  if (outcome.betId === null) {
    throw new Error('the reserve left no bet');
  }
  return { bettor, args, betId: outcome.betId };
}

async function accepted(amount = '100', overrides: Parameters<typeof reserveArgs>[1] = {}) {
  const bet = await placed(amount, overrides);
  applied(
    await h.ledger.confirm({
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: bet.args.providerBetId,
    }),
  );
  return bet;
}

const settle = (
  providerBetId: string,
  result: 'won' | 'lost' | 'void',
  payout: string,
  providerTxId = txId(),
) => h.ledger.settle({ provider: PROVIDER, providerTxId, providerBetId, result, payout });

describe('provider bet through the ledger', () => {
  it('reserve debits the stake from the player wallet and writes one bet row in the reserved state', async () => {
    const { bettor, args, betId } = await placed('100');

    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    const rows = await betRows(args.providerBetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: betId,
      userId: bettor.userId,
      status: 'reserved',
      stake: money(10),
    });
    const wallet = await sportsbookWalletRows(h.testDb, bettor.walletId);
    expect(wallet).toEqual([expect.objectContaining({ type: 'bet', amount: money(10) })]);
    expect((await txRows(args.providerBetId)).map((t) => t.kind)).toEqual(['reserve']);

    const replay = await h.ledger.reserve(args);
    expect(replay).toMatchObject({ status: 'replayed', betId });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(1);
    expect(await betRows(args.providerBetId)).toHaveLength(1);
  });

  it('reserve with a stake above the available balance is refused and writes no ledger transaction', async () => {
    const bettor = await seedBettor(h.testDb, '5');
    const args = reserveArgs(bettor.sessionId, { stake: '10' });

    const outcome = await h.ledger.reserve(args);

    expect(outcome.status).toBe('refused');
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(5));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(0);
    expect(await betRows(args.providerBetId)).toHaveLength(0);
    expect(await txRows(args.providerBetId)).toHaveLength(0);
  });

  it('reserve for a restricted or closed player is refused', async () => {
    const restricted = await seedBettor(h.testDb, '100');
    await db()
      .insert(sportsbookPlayerRestriction)
      .values({ userId: restricted.userId, reason: 'review', restrictedBy: restricted.userId });
    const restrictedArgs = reserveArgs(restricted.sessionId);
    expect(await h.ledger.reserve(restrictedArgs)).toEqual({
      status: 'refused',
      reason: 'sportsbook_restricted',
    });

    const closed = await seedBettor(h.testDb, '100');
    await db()
      .update(ledgerPlayEligibility)
      .set({ status: 'closed' })
      .where(eq(ledgerPlayEligibility.userId, closed.userId));
    const closedArgs = reserveArgs(closed.sessionId);
    expect(await h.ledger.reserve(closedArgs)).toEqual({
      status: 'refused',
      reason: 'account_closed',
    });

    for (const [bettor, args] of [
      [restricted, restrictedArgs],
      [closed, closedArgs],
    ] as const) {
      expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(100));
      expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(0);
      expect(await betRows(args.providerBetId)).toHaveLength(0);
    }
  });

  it('confirm moves a reserved bet to accepted and writes no second wallet movement', async () => {
    const { bettor, args, betId } = await placed('100');
    const walletBefore = await sportsbookWalletRows(h.testDb, bettor.walletId);

    const confirmTx = txId();
    const confirmed = applied(
      await h.ledger.confirm({
        provider: PROVIDER,
        providerTxId: confirmTx,
        providerBetId: args.providerBetId,
      }),
    );

    expect(confirmed).toMatchObject({ status: 'applied', betId, betStatus: 'accepted' });
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(walletBefore);
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect((await betRows(args.providerBetId))[0]?.status).toBe('accepted');
    expect((await txRows(args.providerBetId)).map((t) => t.kind).sort()).toEqual([
      'confirm',
      'reserve',
    ]);
    const again = await h.ledger.confirm({
      provider: PROVIDER,
      providerTxId: confirmTx,
      providerBetId: args.providerBetId,
    });
    expect(again.status).toBe('replayed');
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(walletBefore);
  });

  it('cancel before confirm credits the stake back once', async () => {
    const { bettor, args, betId } = await placed('100');
    const cancelTx = txId();

    const cancelled = applied(
      await h.ledger.cancel({
        provider: PROVIDER,
        providerTxId: cancelTx,
        providerBetId: args.providerBetId,
        reason: 'rejected',
      }),
    );

    expect(cancelled).toMatchObject({ betId, betStatus: 'cancelled', balance: money(100) });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(100));
    expect((await betRows(args.providerBetId))[0]?.status).toBe('cancelled');
    const rows = await sportsbookWalletRows(h.testDb, bettor.walletId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount)).toEqual([money(10), money(10)]);
  });

  it('a repeated cancel with the same request id credits nothing more', async () => {
    const { bettor, args } = await placed('100');
    const cancelTx = txId();
    const cancel = () =>
      h.ledger.cancel({
        provider: PROVIDER,
        providerTxId: cancelTx,
        providerBetId: args.providerBetId,
        reason: 'rejected',
      });
    applied(await cancel());
    const walletAfterFirst = await sportsbookWalletRows(h.testDb, bettor.walletId);

    const outcomes = await Promise.all([cancel(), cancel()]);

    expect(outcomes.map((o) => o.status)).toEqual(['replayed', 'replayed']);
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(100));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(walletAfterFirst);
    expect((await txRows(args.providerBetId)).filter((t) => t.kind === 'cancel')).toHaveLength(1);
  });
});

describe('provider settle and void', () => {
  it('settle a winning bet credits the payout once and marks the bet settled', async () => {
    const { bettor, args, betId } = await accepted('100', { stake: '10', potentialPayout: '25' });
    const settleTx = txId();

    const outcome = applied(await settle(args.providerBetId, 'won', '25', settleTx));

    expect(outcome).toMatchObject({ betId, betStatus: 'settled', balance: money(115) });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
    expect((await betRows(args.providerBetId))[0]).toMatchObject({
      status: 'settled',
      result: 'won',
    });
    const payouts = (await sportsbookWalletRows(h.testDb, bettor.walletId)).filter(
      (r) => r.amount === money(25),
    );
    expect(payouts).toHaveLength(1);
    expect(await settle(args.providerBetId, 'won', '25', settleTx)).toMatchObject({
      status: 'replayed',
    });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
  });

  it('settle a losing bet writes a zero payout and no wallet credit', async () => {
    const { bettor, args, betId } = await accepted('100');
    const before = await sportsbookWalletRows(h.testDb, bettor.walletId);

    const outcome = applied(await settle(args.providerBetId, 'lost', '0'));

    expect(outcome).toMatchObject({ betId, betStatus: 'settled', balance: money(90) });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(before);
    expect((await betRows(args.providerBetId))[0]).toMatchObject({
      status: 'settled',
      result: 'lost',
    });
    expect((await txRows(args.providerBetId)).find((t) => t.kind === 'settle')).toMatchObject({
      amount: money(0),
      result: 'lost',
    });
  });

  it('a repeated settle with the same fingerprint returns the stored outcome and writes nothing', async () => {
    const { bettor, args } = await accepted('100');
    const settleTx = txId();
    const first = applied(await settle(args.providerBetId, 'won', '25', settleTx));
    const walletRows = await sportsbookWalletRows(h.testDb, bettor.walletId);
    const txBefore = await txRows(args.providerBetId);

    const repeats = await Promise.all([
      settle(args.providerBetId, 'won', '25', settleTx),
      settle(args.providerBetId, 'won', '25', settleTx),
    ]);

    for (const repeat of repeats) {
      expect(repeat).toEqual({ ...first, status: 'replayed' });
    }
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(walletRows);
    expect(await txRows(args.providerBetId)).toEqual(txBefore);
  });

  it('a settle with the same request id but a different payload is refused as a fingerprint mismatch', async () => {
    const { bettor, args, betId } = await accepted('100');
    const settleTx = txId();
    applied(await settle(args.providerBetId, 'won', '25', settleTx));

    const outcome = await settle(args.providerBetId, 'won', '999', settleTx);

    expect(outcome).toEqual({ status: 'refused', reason: 'fingerprint_mismatch' });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(2);
    const findings = await db()
      .select()
      .from(sportsbookReconciliationFinding)
      .where(eq(sportsbookReconciliationFinding.betId, betId));
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'fingerprint_mismatch', status: 'open' }),
    ]);
  });

  it('void restores the stake once and a second void changes nothing', async () => {
    const { bettor, args } = await accepted('100');

    const first = applied(await settle(args.providerBetId, 'void', '10'));
    expect(first).toMatchObject({ betStatus: 'settled', balance: money(100) });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(100));
    const walletRows = await sportsbookWalletRows(h.testDb, bettor.walletId);
    const txBefore = await txRows(args.providerBetId);

    const second = await settle(args.providerBetId, 'void', '10');

    expect(second.status).toBe('refused');
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(100));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toEqual(walletRows);
    expect(await txRows(args.providerBetId)).toEqual(txBefore);
  });

  it('reopen of a settled bet reverses the payout and returns the bet to accepted', async () => {
    const { bettor, args, betId } = await accepted('100');
    applied(await settle(args.providerBetId, 'won', '25'));
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
    const reopenTx = txId();

    const reopened = applied(
      await h.ledger.reopen({
        provider: PROVIDER,
        providerTxId: reopenTx,
        providerBetId: args.providerBetId,
      }),
    );

    expect(reopened).toMatchObject({ betId, betStatus: 'accepted', balance: money(90) });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect((await betRows(args.providerBetId))[0]?.status).toBe('accepted');
    const again = await h.ledger.reopen({
      provider: PROVIDER,
      providerTxId: reopenTx,
      providerBetId: args.providerBetId,
    });
    expect(again.status).toBe('replayed');
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    const resettled = applied(await settle(args.providerBetId, 'won', '30'));
    expect(resettled.balance).toBe(money(120));
  });

  it('settling a bet that was never reserved is refused', async () => {
    const providerBetId = `bet-${txId()}`;

    const outcome = await settle(providerBetId, 'won', '25');

    expect(outcome.status).toBe('refused');
    expect(await betRows(providerBetId)).toHaveLength(0);
    expect(await txRows(providerBetId)).toHaveLength(0);
  });

  it('a settle whose payout is negative or malformed is refused', async () => {
    const { bettor, args } = await accepted('100');

    for (const payout of ['-5', 'abc', '1e3', '']) {
      expect(await settle(args.providerBetId, 'won', payout)).toEqual({
        status: 'refused',
        reason: 'invalid_amount',
      });
    }

    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(1);
    expect((await betRows(args.providerBetId))[0]?.status).toBe('accepted');
    expect((await txRows(args.providerBetId)).map((t) => t.kind).sort()).toEqual([
      'confirm',
      'reserve',
    ]);
  });

  it('two concurrent settles of one bet credit the payout exactly once', async () => {
    const { bettor, args } = await accepted('100');

    const outcomes = await Promise.all([
      settle(args.providerBetId, 'won', '25'),
      settle(args.providerBetId, 'won', '25'),
      settle(args.providerBetId, 'won', '25'),
    ]);

    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'refused')).toHaveLength(2);
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(115));
    const payouts = (await sportsbookWalletRows(h.testDb, bettor.walletId)).filter(
      (r) => r.amount === money(25),
    );
    expect(payouts).toHaveLength(1);
    expect((await txRows(args.providerBetId)).filter((t) => t.kind === 'settle')).toHaveLength(1);
  });
});

describe('stake resolution and promotions', () => {
  it('a promotion-paid stake debits no cash and resolves a cash stake of zero while a player-paid stake debits it in full', async () => {
    const free = await placed('100', {
      stake: '10',
      promotion: { type: 'free-bet', stake: 'promotion', voidReturnsStake: false },
    });
    const paid = await placed('100', {
      stake: '10',
      promotion: { type: 'risk-free', stake: 'player', refundsLoss: true },
    });

    expect(await balanceOf(h.testDb, free.bettor.walletId)).toBe(money(100));
    expect(await sportsbookWalletRows(h.testDb, free.bettor.walletId)).toHaveLength(0);
    expect((await betRows(free.args.providerBetId))[0]).toMatchObject({
      stake: money(10),
      cashStake: money(0),
      voidPayout: money(0),
      maxLossRefund: money(0),
    });
    expect(await balanceOf(h.testDb, paid.bettor.walletId)).toBe(money(90));
    expect((await betRows(paid.args.providerBetId))[0]).toMatchObject({
      stake: money(10),
      cashStake: money(10),
      voidPayout: money(10),
      maxLossRefund: money(10),
    });
  });

  it('a promotion payout outside the usual range raises a finding without blocking the payout', async () => {
    const legs = [
      {
        eventId: 'event-1',
        odds: '2.00',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ];
    const unusual = await accepted('100', {
      stake: '10',
      potentialPayout: '500',
      legs,
      promotion: { type: 'free-bet', stake: 'promotion', voidReturnsStake: false },
    });
    const usual = await accepted('100', {
      stake: '10',
      potentialPayout: '500',
      legs,
      promotion: { type: 'free-bet', stake: 'promotion', voidReturnsStake: false },
    });

    applied(await settle(unusual.args.providerBetId, 'won', '400'));
    applied(await settle(usual.args.providerBetId, 'won', '20'));

    expect(await balanceOf(h.testDb, unusual.bettor.walletId)).toBe(money(500));
    expect((await betRows(unusual.args.providerBetId))[0]?.status).toBe('settled');
    const flagged = await db()
      .select()
      .from(sportsbookReconciliationFinding)
      .where(
        and(
          eq(sportsbookReconciliationFinding.betId, unusual.betId),
          eq(sportsbookReconciliationFinding.kind, 'promotion_payout_unusual'),
        ),
      );
    expect(flagged).toEqual([
      expect.objectContaining({ status: 'open', userId: unusual.bettor.userId }),
    ]);
    expect(await balanceOf(h.testDb, usual.bettor.walletId)).toBe(money(120));
    expect(
      await db()
        .select()
        .from(sportsbookReconciliationFinding)
        .where(eq(sportsbookReconciliationFinding.betId, usual.betId)),
    ).toHaveLength(0);
  });

  it('a stale reserve the provider cannot resolve is recorded for reconciliation, not applied', async () => {
    const { bettor, args, betId } = await placed('100');
    await db()
      .update(sportsbookBet)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(sportsbookBet.id, betId));

    const summary = await h.reconcile.run();

    expect(summary.reservesChecked).toBeGreaterThanOrEqual(1);
    const [bet] = await betRows(args.providerBetId);
    expect(bet).toMatchObject({ status: 'reserved', reconcileAttempts: 1 });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
    expect(await sportsbookWalletRows(h.testDb, bettor.walletId)).toHaveLength(1);
    expect((await txRows(args.providerBetId)).map((t) => t.kind)).toEqual(['reserve']);
  });
});

describe('reconciliation', () => {
  const overdue = async (betId: string) =>
    db()
      .update(sportsbookBet)
      .set({ lastLegStartsAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(sportsbookBet.id, betId));

  const findingsOf = (betId: string) =>
    db()
      .select()
      .from(sportsbookReconciliationFinding)
      .where(eq(sportsbookReconciliationFinding.betId, betId));

  const reconcileUntilFiled = async (betId: string) => {
    for (;;) {
      const { overdueFiled } = await h.reconcile.run();
      if (overdueFiled === 0 || (await findingsOf(betId)).length > 0) {
        return;
      }
    }
  };

  it('reconciling an accepted bet still unsettled long after its last leg raises a finding', async () => {
    const { bettor, args, betId } = await accepted('100');
    await overdue(betId);

    await reconcileUntilFiled(betId);

    expect(await findingsOf(betId)).toEqual([
      expect.objectContaining({
        kind: 'settlement_overdue',
        status: 'open',
        userId: bettor.userId,
      }),
    ]);
    expect((await betRows(args.providerBetId))[0]?.status).toBe('accepted');
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(90));
  });

  it('reconciling a bet that is not overdue raises nothing', async () => {
    const live = await accepted('100');
    const settled = await accepted('100');
    await overdue(settled.betId);
    applied(await settle(settled.args.providerBetId, 'lost', '0'));

    await h.reconcile.run();

    expect(await findingsOf(live.betId)).toHaveLength(0);
    expect(await findingsOf(settled.betId)).toHaveLength(0);
    expect(await balanceOf(h.testDb, live.bettor.walletId)).toBe(money(90));
  });

  it('running reconcile twice raises one finding per mismatch', async () => {
    const { betId } = await accepted('100');
    await overdue(betId);

    await reconcileUntilFiled(betId);
    await reconcileUntilFiled(betId);

    expect(await findingsOf(betId)).toHaveLength(1);
  });

  it('a debt left by a reopen after the wallet was drained is recorded and can be collected once', async () => {
    const won = await accepted('100', { stake: '10', potentialPayout: '50' });
    const { bettor } = won;
    applied(await settle(won.args.providerBetId, 'won', '50'));
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(140));
    applied(
      await h.ledger.reserve(
        reserveArgs(bettor.sessionId, { stake: '130', potentialPayout: '200' }),
      ),
    );
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(10));

    applied(
      await h.ledger.reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: won.args.providerBetId,
      }),
    );

    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(0));
    const [debt] = await db()
      .select()
      .from(sportsbookPlayerDebt)
      .where(eq(sportsbookPlayerDebt.userId, bettor.userId));
    expect(debt).toMatchObject({
      owed: money(40),
      outstanding: money(40),
      collected: money(0),
      status: 'open',
    });
    if (!debt) {
      throw new Error('the reopen left no debt');
    }

    await db()
      .update(walletBalance)
      .set({ amount: '100' })
      .where(eq(walletBalance.walletId, bettor.walletId));
    const actor = { userId: bettor.userId, role: 'admin', ip: null, userAgent: null };
    const collected = await h.debts.collect(debt.id, { idempotencyKey: randomUUID() }, actor);

    expect(collected).toMatchObject({
      collected: money(40),
      outstanding: money(0),
      status: 'cleared',
    });
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(60));
    await expect(
      h.debts.collect(debt.id, { idempotencyKey: randomUUID() }, actor),
    ).rejects.toThrow();
    expect(await balanceOf(h.testDb, bettor.walletId)).toBe(money(60));
    const [after] = await db()
      .select()
      .from(sportsbookPlayerDebt)
      .where(eq(sportsbookPlayerDebt.id, debt.id));
    expect(after).toMatchObject({ collected: money(40), outstanding: money(0), status: 'cleared' });
  });
});
