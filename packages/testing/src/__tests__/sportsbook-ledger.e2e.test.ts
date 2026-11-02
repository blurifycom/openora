import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { auditLog } from '@openora/core/audit/schema';
import { MESSAGE_BROKER, type SportsbookConfirmArgs } from '@openora/core/contracts';
import { betting } from '@openora/core/sportsbook/contracts';
import { DRIZZLE, eventOutbox, processedEvents } from '@openora/core/server';
import { player as playerProfile } from '@openora/core/pam/schema/profile';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookPlayerDebt,
  sportsbookReconciliationFinding,
} from '@openora/core/sportsbook/schema/betting';
import { walletTransaction, wallet, walletWithdrawalHold } from '@openora/core/wallet/schema';
import { closeE2e, type TestApp, type TestClient, type TestDb } from '../index.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PROVIDER,
  type SportsbookPlayer,
  acceptedBet,
  balanceOf,
  bootSportsbookApp,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  reserveArgs,
  txId,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app);
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const findings = (betId: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(sportsbookReconciliationFinding)
    .where(eq(sportsbookReconciliationFinding.betId, betId));

const findingsByKey = (dedupeKey: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(sportsbookReconciliationFinding)
    .where(eq(sportsbookReconciliationFinding.dedupeKey, dedupeKey));

const betRow = async (betId: string) => {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select()
    .from(sportsbookBet)
    .where(eq(sportsbookBet.id, betId));
  return row!;
};

const ledgerRows = async (userId: string) =>
  app.container
    .get(DRIZZLE)
    .db.select({
      type: walletTransaction.type,
      amount: walletTransaction.amount,
      providerRefId: walletTransaction.providerRefId,
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(eq(wallet.userId, userId), eq(walletTransaction.providerName, `sportsbook:${PROVIDER}`)),
    );

describe('sportsbook ledger', () => {
  it('debits the stake on reserve and pays the total payout on settle', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');

    const settled = expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );
    expect(settled).toMatchObject({ status: 'applied', betStatus: 'settled', betVersion: 1 });
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
    expect((await betRow(betId)).payoutTotal).toBe('25.000000000000000000');
  });

  it('answers a retried transaction from the stored row and moves nothing again', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const first = expectApplied(await ledgerOf(app).reserve(args));
    const again = expectApplied(await ledgerOf(app).reserve(args));
    expect(again).toMatchObject({ status: 'replayed', betId: first.betId, betStatus: 'reserved' });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
    expect(await ledgerRows(player.userId)).toEqual([
      { type: 'bet', amount: '10.000000000000000000', providerRefId: `tx:${args.providerTxId}` },
    ]);

    expectApplied(
      await ledgerOf(app).confirm({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
      }),
    );
    expect(expectApplied(await ledgerOf(app).reserve(args))).toEqual(again);
  });

  it('answers a replayed reserve with what the first call got, after a later settle', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, { stake: '10', potentialPayout: '25' });
    const first = expectApplied(await ledgerOf(app).reserve(args));
    expectApplied(
      await ledgerOf(app).confirm({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
      }),
    );
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );

    expect(await ledgerOf(app).reserve(args)).toEqual({ ...first, status: 'replayed' });
    expect(first).toMatchObject({ betStatus: 'reserved', balance: '90.000000000000000000' });
  });

  it.each([
    { why: 'stake', change: { stake: '11' } },
    { why: 'potential payout', change: { potentialPayout: '26' } },
    {
      why: 'legs',
      change: {
        legs: [{ eventId: 'event-2', startsAt: new Date(Date.now() + 60_000).toISOString() }],
      },
    },
  ])(
    'refuses a reserve transaction id reused with another $why and files it',
    async ({ change }) => {
      const player = await fundedPlayer(app, '100');
      const args = reserveArgs(player.sessionId);
      const first = expectApplied(await ledgerOf(app).reserve(args));
      const reused = await ledgerOf(app).reserve({ ...args, ...change });
      expect(reused).toEqual({ status: 'refused', reason: 'fingerprint_mismatch' });
      expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
      const filed = await findingsByKey(`fingerprint_mismatch:${PROVIDER}:${args.providerTxId}`);
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({
        kind: 'fingerprint_mismatch',
        betId: first.betId,
        userId: player.userId,
      });
    },
  );

  it('refuses and files the loser when two players reserve under one transaction id at once', async () => {
    const [first, second] = await Promise.all([fundedPlayer(app, '100'), fundedPlayer(app, '100')]);
    const providerTxId = txId();
    const outcomes = await Promise.all(
      [first, second].map((player) =>
        ledgerOf(app).reserve({ ...reserveArgs(player.sessionId), providerTxId }),
      ),
    );
    expect(outcomes.map((o) => o.status).sort()).toEqual(['applied', 'refused']);
    expect(outcomes.find((o) => o.status === 'refused')).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });
    expect(await findingsByKey(`fingerprint_mismatch:${PROVIDER}:${providerTxId}`)).toHaveLength(1);
    const balances = await Promise.all([first, second].map((p) => balanceOf(app, p.userId)));
    expect(balances.sort()).toEqual(['100.000000000000000000', '90.000000000000000000']);
  });

  it('refuses and files a provider transaction id in the align namespace', async () => {
    const player = await fundedPlayer(app, '100');
    const providerTxId = `core-align:${txId()}:v1:confirm`;
    expect(await ledgerOf(app).reserve({ ...reserveArgs(player.sessionId), providerTxId })).toEqual(
      { status: 'refused', reason: 'fingerprint_mismatch' },
    );
    expect(await findingsByKey(`fingerprint_mismatch:${PROVIDER}:${providerTxId}`)).toHaveLength(1);
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('refuses a reopen that loses its transaction id to another player mid-flight', async () => {
    const [first, second] = await Promise.all([fundedPlayer(app, '100'), fundedPlayer(app, '100')]);
    const won = await acceptedBet(app, first, { stake: '10', potentialPayout: '25' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: won.args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );
    const open = await acceptedBet(app, second, { stake: '10', potentialPayout: '25' });
    const providerTxId = txId();
    const db = app.container.get(DRIZZLE).db;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(wallet).where(eq(wallet.userId, first.userId)).for('update');
      held();
      await released;
    });
    await holding;
    const reopening = ledgerOf(app).reopen({
      provider: PROVIDER,
      providerTxId,
      providerBetId: won.args.providerBetId,
    });
    await vi.waitFor(async () => {
      const { rows } = await db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%from "wallet"%for no key update%'`,
      );
      expect(rows[0]?.waiting).toBeGreaterThan(0);
    });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId,
        providerBetId: open.args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );
    release();
    await holder;

    expect(await reopening).toEqual({ status: 'refused', reason: 'fingerprint_mismatch' });
    expect((await betRow(won.betId)).status).toBe('settled');
    expect(await balanceOf(app, first.userId)).toBe('115.000000000000000000');
    expect(await balanceOf(app, second.userId)).toBe('115.000000000000000000');
  });

  it('refuses a second reserve for a bet core already holds and files it', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    const again = { ...args, providerTxId: txId() };
    expect(await ledgerOf(app).reserve(again)).toEqual({
      status: 'refused',
      reason: 'illegal_transition',
    });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
    const filed = await findingsByKey(`provider_mismatch:${PROVIDER}:${again.providerTxId}`);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ betId, userId: player.userId });
  });

  it.each([
    { why: 'a negative stake', overrides: { stake: '-5' } },
    { why: 'a stake with more decimals than the currency', overrides: { stake: '10.001' } },
    { why: 'a potential payout that is not an amount', overrides: { potentialPayout: 'abc' } },
    {
      why: 'a potential payout with more decimals than the currency',
      overrides: { potentialPayout: '25.001' },
    },
  ])('refuses $why and files it', async ({ overrides }) => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, overrides);
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
    expect(await findingsByKey(`invalid_amount:${PROVIDER}:${args.providerTxId}`)).toHaveLength(1);
  });

  it('refuses a reserve on a session id that is not one core issued', async () => {
    expect(await ledgerOf(app).reserve(reserveArgs('not-a-session'))).toEqual({
      status: 'refused',
      reason: 'session_invalid',
    });
  });

  it('refuses a settle whose payout is not an amount and files it', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    const settle = {
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: args.providerBetId,
      result: 'won' as const,
      payout: 'abc',
    };
    expect(await ledgerOf(app).settle(settle)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await findingsByKey(`invalid_amount:${PROVIDER}:${settle.providerTxId}`)).toHaveLength(
      1,
    );
  });

  it('throws on a request that names no transaction', async () => {
    await expect(
      ledgerOf(app).confirm({ provider: PROVIDER, providerTxId: '', providerBetId: 'bet-x' }),
    ).rejects.toMatchObject({
      name: 'ZodError',
      issues: [expect.objectContaining({ path: ['providerTxId'] })],
    });
  });

  it('accepts a leg start time with a utc offset', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, {
      legs: [{ eventId: 'event-1', startsAt: '2030-01-01T14:00:00+02:00' }],
    });
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    expect((await betRow(betId!)).lastLegStartsAt.toISOString()).toBe('2030-01-01T12:00:00.000Z');
  });

  it('refuses a reserve that arrives after the provider discarded the bet', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const tombstone = expectApplied(
      await ledgerOf(app).cancel({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        reason: 'discarded',
      }),
    );
    expect(tombstone).toMatchObject({ status: 'applied', betId: null });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'illegal_transition',
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('never takes a stake when a discard races its reserve', async () => {
    for (let round = 0; round < 10; round++) {
      const player = await fundedPlayer(app, '100');
      const args = reserveArgs(player.sessionId);
      const [reserved, cancelled] = await Promise.all([
        ledgerOf(app).reserve(args),
        ledgerOf(app).cancel({
          provider: PROVIDER,
          providerTxId: txId(),
          providerBetId: args.providerBetId,
          reason: 'discarded',
        }),
      ]);
      expect(cancelled.status).toBe('applied');
      expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
      if (reserved.status !== 'refused') {
        expect((await betRow(reserved.betId!)).status).toBe('cancelled');
      }
    }
  });

  it('applies exactly one of a settle and a void racing on one bet', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    const settle = (result: 'won' | 'void', payout: string) =>
      ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result,
        payout,
      });
    const outcomes = await Promise.all([settle('won', '25'), settle('void', '10')]);
    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'refused')).toEqual([
      { status: 'refused', reason: 'illegal_transition' },
    ]);
    const bet = await betRow(betId);
    const expected = bet.result === 'won' ? '115' : '100';
    expect(await balanceOf(app, player.userId)).toBe(`${expected}.000000000000000000`);
  });

  it('refuses a stake the balance does not cover and writes nothing', async () => {
    const player = await fundedPlayer(app, '5');
    const args = reserveArgs(player.sessionId, { stake: '10' });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'insufficient_funds',
    });
    const bets = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(sportsbookBet)
      .where(eq(sportsbookBet.providerBetId, args.providerBetId));
    expect(bets).toHaveLength(0);
    expect(await balanceOf(app, player.userId)).toBe('5.000000000000000000');
  });

  it('refuses a stake over the wager limit and moves nothing', async () => {
    const player = await fundedPlayer(app, '100');
    const limit = await admin.put(`/compliance/players/${player.userId}/limits`, {
      type: 'wager',
      amount: '5',
      minutes: null,
      currency: 'USD',
      period: 'daily',
      reason: 'wager limit below the stake',
      confirm: true,
    });
    expect(limit.status).toBe(200);
    const args = reserveArgs(player.sessionId, { stake: '10' });
    expect(await ledgerOf(app).reserve(args)).toEqual({ status: 'refused', reason: 'limit' });
    const bets = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(sportsbookBet)
      .where(eq(sportsbookBet.providerBetId, args.providerBetId));
    expect(bets).toHaveLength(0);
    expect(await ledgerRows(player.userId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('pays a payout above the potential payout and files it', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { potentialPayout: '25' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '40',
      }),
    );
    expect(await balanceOf(app, player.userId)).toBe('130.000000000000000000');
    expect((await findings(betId)).map((f) => f.kind)).toEqual(['payout_above_potential']);
  });

  it.each([
    { result: 'void' as const, payout: '9', why: 'a void that does not return the stake' },
    { result: 'lost' as const, payout: '1', why: 'a loss that pays' },
    { result: 'won' as const, payout: '25.001', why: 'more decimals than the currency has' },
  ])('refuses $why and files it', async ({ result, payout }) => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    expect(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result,
        payout,
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_amount' });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
    expect((await findings(betId)).map((f) => f.kind)).toEqual(['invalid_amount']);
  });

  it('turns a reopen shortfall into debt and a hold, then offsets it from a later win', async () => {
    const player = await fundedPlayer(app, '100');
    const first = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expectApplied(await settleWon(first.args.providerBetId, '25'));
    const second = await acceptedBet(app, player, { stake: '115', potentialPayout: '230' });
    expect(await balanceOf(app, player.userId)).toBe('0.000000000000000000');

    const reopened = expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: first.args.providerBetId,
      }),
    );
    expect(reopened).toMatchObject({ betStatus: 'accepted', betVersion: 2 });
    expect(await debtOf(player)).toMatchObject({ outstanding: '25.000000000000000000' });
    expect(await holdsOf(player)).toHaveLength(1);
    expect((await findings(first.betId)).map((f) => f.kind)).toEqual(['debt_recorded']);

    const winTx = txId();
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: winTx,
        providerBetId: second.args.providerBetId,
        result: 'won',
        payout: '230',
      }),
    );
    expect(await balanceOf(app, player.userId)).toBe('205.000000000000000000');
    expect(await debtOf(player)).toMatchObject({
      collected: '25.000000000000000000',
      outstanding: '0.000000000000000000',
    });
    expect(await holdsOf(player)).toHaveLength(0);

    const third = await acceptedBet(app, player, { stake: '5', potentialPayout: '10' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: `${winTx}:offset`,
        providerBetId: third.args.providerBetId,
        result: 'won',
        payout: '10',
      }),
    );
    expect(await balanceOf(app, player.userId)).toBe('210.000000000000000000');
    const refs = (await ledgerRows(player.userId)).map((row) => row.providerRefId);
    expect(refs).toEqual(
      expect.arrayContaining([
        `tx:${winTx}`,
        expect.stringMatching(new RegExp(`^offset:${PROVIDER}:${winTx}:[0-9a-f-]{36}$`)),
        `tx:${winTx}:offset`,
      ]),
    );
  });

  it('refuses and files a reopen that would take back more than the wallet paid the bet', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expectApplied(await settleWon(args.providerBetId, '25'));
    await app.container
      .get(DRIZZLE)
      .db.update(sportsbookBet)
      .set({ payoutTotal: '40' })
      .where(eq(sportsbookBet.id, betId));

    const reopen = { provider: PROVIDER, providerTxId: txId(), providerBetId: args.providerBetId };
    expect(await ledgerOf(app).reopen(reopen)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 1 });
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
    expect(await findingsByKey(`invalid_amount:${PROVIDER}:${reopen.providerTxId}`)).toMatchObject([
      { betId, detail: { reversed: '40.000000000000000000', type: 'win_reversal' } },
    ]);
  });

  it('settles a reopened void again at the next version and ignores a late duplicate', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    const settleV1 = {
      provider: PROVIDER,
      providerBetId: args.providerBetId,
      result: 'void' as const,
      payout: '10',
      expectedVersion: 1,
    };
    expectApplied(await ledgerOf(app).settle({ ...settleV1, providerTxId: txId() }));
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');

    const reopened = expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        expectedVersion: 1,
      }),
    );
    expect(reopened.betVersion).toBe(2);
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');

    expect(await ledgerOf(app).settle({ ...settleV1, providerTxId: txId() })).toEqual({
      status: 'refused',
      reason: 'illegal_transition',
    });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '25',
        expectedVersion: 2,
      }),
    );
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 2, result: 'won' });
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
  });

  it('keeps each currency on its own balance', async () => {
    const player = await fundedPlayer(app, '50', 'EUR');
    const { args } = await acceptedBet(app, player, { currency: 'EUR', stake: '20' });
    expect(await balanceOf(app, player.userId, 'EUR')).toBe('30.000000000000000000');
    const settled = expectApplied(await settleWon(args.providerBetId, '25'));
    expect(settled).toMatchObject({ currency: 'EUR', balance: '55.000000000000000000' });
    expect(await balanceOf(app, player.userId, 'USD')).toBe('0');
  });

  it('refuses a stake for a restricted player but still settles their open bets', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player);
    await restrict(player.userId);
    try {
      expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
        status: 'refused',
        reason: 'session_invalid',
      });
      expectApplied(await settleWon(args.providerBetId, '25'));
      expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
    } finally {
      await lift(player.userId);
    }
  });

  it('refuses stakes while suspended but still settles open bets', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player);
    await suspend();
    try {
      expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
        status: 'refused',
        reason: 'suspended',
      });
      expectApplied(await settleWon(args.providerBetId, '25'));
    } finally {
      await resume();
    }
  });

  it('never deadlocks or breaks the balance under mixed concurrent work for one player', async () => {
    const player = await fundedPlayer(app, '1000');
    const settled = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const bet = await acceptedBet(app, player, { stake: '10', potentialPayout: '30' });
        expectApplied(await settleWon(bet.args.providerBetId, '30'));
        return bet;
      }),
    );
    const open = await Promise.all(Array.from({ length: 4 }, () => acceptedBet(app, player)));

    const errors: unknown[] = [];
    const guard = (p: Promise<unknown>) => p.catch((err: unknown) => errors.push(err));
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        guard(ledgerOf(app).reserve(reserveArgs(player.sessionId, { stake: '5' }))),
      ),
      ...open.map((bet) => guard(settleWon(bet.args.providerBetId, '25'))),
      ...settled.map((bet) =>
        guard(
          ledgerOf(app).reopen({
            provider: PROVIDER,
            providerTxId: txId(),
            providerBetId: bet.args.providerBetId,
          }),
        ),
      ),
      guard(restrict(player.userId).then(() => lift(player.userId))),
      guard(suspend().then(resume)),
    ]);
    expect(errors).toEqual([]);

    const rows = await ledgerRows(player.userId);
    const signed = rows.reduce((sum, row) => {
      const amount = Number(row.amount);
      return row.type === 'win' || row.type === 'bet_reversal' ? sum + amount : sum - amount;
    }, 0);
    expect(Number(await balanceOf(app, player.userId))).toBeCloseTo(1000 + signed, 6);
    expect(await debtOf(player)).toBeUndefined();
  }, 60_000);
});

describe('confirm at changed odds', () => {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  const leg = { eventId: 'event-1', market: '1x2', selection: 'home', odds: '2.5', startsAt };
  const second = { eventId: 'event-2', market: '1x2', selection: 'away', odds: '1.2', startsAt };

  const reserved = async (player: SportsbookPlayer) => {
    const args = reserveArgs(player.sessionId, {
      stake: '10',
      potentialPayout: '30',
      legs: [leg, second],
    });
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    return { args, betId: betId! };
  };

  const confirm = (
    providerBetId: string,
    terms: Pick<SportsbookConfirmArgs, 'potentialPayout' | 'legs'>,
  ) => ledgerOf(app).confirm({ provider: PROVIDER, providerTxId: txId(), providerBetId, ...terms });

  const transactions = (betId: string) =>
    app.container
      .get(DRIZZLE)
      .db.select({
        kind: sportsbookBetTransaction.kind,
        potentialPayout: sportsbookBetTransaction.potentialPayout,
        legs: sportsbookBetTransaction.legs,
      })
      .from(sportsbookBetTransaction)
      .where(eq(sportsbookBetTransaction.betId, betId))
      .orderBy(asc(sportsbookBetTransaction.createdAt));

  const acceptedAudit = async (betId: string) => {
    let after: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const [row] = await app.container
        .get(DRIZZLE)
        .db.select({ after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, betId), eq(auditLog.action, 'sportsbook.bet.accepted')));
      expect(row).toBeDefined();
      after = row!.after as Record<string, unknown>;
    });
    return after!;
  };

  const settleWon = (providerBetId: string, payout: string) =>
    ledgerOf(app).settle({
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId,
      result: 'won',
      payout,
    });

  it('accepts at higher odds and settles the higher payout without a finding', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    const legs = [{ ...leg, odds: '3' }, second];

    expect(
      expectApplied(await confirm(args.providerBetId, { potentialPayout: '36', legs })),
    ).toMatchObject({
      status: 'applied',
      betStatus: 'accepted',
    });
    expect(await betRow(betId)).toMatchObject({
      stake: '10.000000000000000000',
      potentialPayout: '36.000000000000000000',
      legs,
    });
    expect(await transactions(betId)).toEqual([
      { kind: 'reserve', potentialPayout: '30.000000000000000000', legs: [leg, second] },
      { kind: 'confirm', potentialPayout: '36.000000000000000000', legs },
    ]);
    expect(await acceptedAudit(betId)).toMatchObject({
      potentialPayout: '36.000000000000000000',
      legs,
    });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');

    expectApplied(await settleWon(args.providerBetId, '36'));
    expect(await balanceOf(app, player.userId)).toBe('126.000000000000000000');
    expect(await findings(betId)).toEqual([]);
  });

  it('accepts at lower odds and files a settle above the confirmed potential', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);

    expectApplied(
      await confirm(args.providerBetId, {
        potentialPayout: '24',
        legs: [{ ...leg, odds: '2' }, second],
      }),
    );
    expect((await betRow(betId)).potentialPayout).toBe('24.000000000000000000');

    expectApplied(await settleWon(args.providerBetId, '28'));
    expect(await balanceOf(app, player.userId)).toBe('118.000000000000000000');
    expect((await findings(betId)).map((f) => f.kind)).toEqual(['payout_above_potential']);
  });

  it('keeps the reserved terms when the confirm carries none', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    expectApplied(await confirm(args.providerBetId, {}));
    expect(await betRow(betId)).toMatchObject({
      potentialPayout: '30.000000000000000000',
      legs: [leg, second],
    });
    expect((await transactions(betId))[1]).toEqual({
      kind: 'confirm',
      potentialPayout: null,
      legs: null,
    });
    const after = await acceptedAudit(betId);
    expect(after['potentialPayout']).toBe('30.000000000000000000');
    expect(after).not.toHaveProperty('legs');
  });

  it('audits every callback leg under its player, in the leg transaction', async () => {
    const { args, betId } = await acceptedBet(app, await fundedPlayer(app, '100'));
    const on = { provider: PROVIDER, providerBetId: args.providerBetId };
    expectApplied(
      await ledgerOf(app).settle({ ...on, providerTxId: txId(), result: 'won', payout: '25' }),
    );
    expectApplied(await ledgerOf(app).reopen({ ...on, providerTxId: txId() }));

    const rows = await app.container
      .get(DRIZZLE)
      .db.select({ action: auditLog.action, actorType: auditLog.actorType, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.resourceId, betId))
      .orderBy(asc(auditLog.seq));
    expect(rows.map((r) => r.action)).toEqual([
      'sportsbook.bet.placed',
      'sportsbook.bet.accepted',
      'sportsbook.bet.settled',
      'sportsbook.bet.reopened',
    ]);
    for (const row of rows) {
      expect(row.actorType).toBe('player');
      expect((row.after as { playerId?: unknown }).playerId).toEqual(expect.any(String));
    }
  });

  it('keeps one audit row when the broker redelivers a callback event', async () => {
    const drizzle = app.container.get(DRIZZLE).db;
    const placedAudits = (betId: string) =>
      drizzle
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, betId), eq(auditLog.action, 'sportsbook.bet.placed')));
    const placedEvent = async (betId: string) => {
      const [row] = await drizzle
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.topic, 'sportsbook.bet.placed'),
            sql`${eventOutbox.payload}->>'betId' = ${betId}`,
          ),
        );
      return row!;
    };
    const handled = async (eventId: string) =>
      (
        await drizzle
          .select({ consumer: processedEvents.consumer })
          .from(processedEvents)
          .where(eq(processedEvents.eventId, eventId))
      ).length;
    const first = await reserved(await fundedPlayer(app, '100'));
    const outboxed = await placedEvent(first.betId);
    await vi.waitFor(async () => expect(await handled(outboxed.eventId)).toBeGreaterThan(0));
    const consumers = await handled(outboxed.eventId);

    await app.container.get(MESSAGE_BROKER).publish({
      eventId: outboxed.eventId,
      topic: outboxed.topic,
      payload: outboxed.payload,
      occurredAt: outboxed.occurredAt.toISOString(),
      schemaVersion: outboxed.schemaVersion,
    });
    const later = await placedEvent((await reserved(await fundedPlayer(app, '100'))).betId);
    await vi.waitFor(async () => expect(await handled(later.eventId)).toBe(consumers));
    expect(await handled(outboxed.eventId)).toBe(consumers);
    expect(await placedAudits(first.betId)).toHaveLength(1);
  });

  const moved = { ...leg, odds: '3' };

  it.each([
    {
      why: 'a leg on another event',
      terms: { potentialPayout: '36', legs: [{ ...moved, eventId: 'event-9' }, second] },
      fields: ['legs'],
    },
    {
      why: 'another selection',
      terms: { potentialPayout: '36', legs: [{ ...moved, selection: 'draw' }, second] },
      fields: ['legs'],
    },
    {
      why: 'a moved start time',
      terms: {
        potentialPayout: '36',
        legs: [{ ...moved, startsAt: new Date(0).toISOString() }, second],
      },
      fields: ['legs'],
    },
    { why: 'a dropped leg', terms: { potentialPayout: '36', legs: [moved] }, fields: ['legs'] },
    {
      why: 'reordered legs',
      terms: { potentialPayout: '36', legs: [second, moved] },
      fields: ['legs'],
    },
    {
      why: 'a payout below the stake',
      terms: { potentialPayout: '9.99', legs: [{ ...leg, odds: '0.9' }, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'more decimals than the currency has',
      terms: { potentialPayout: '36.001', legs: [moved, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a raised payout at unchanged odds',
      terms: { potentialPayout: '1000', legs: [leg, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a payout kept after the odds dropped',
      terms: { potentialPayout: '30', legs: [{ ...leg, odds: '2' }, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a payout raised as the odds dropped',
      terms: { potentialPayout: '31', legs: [{ ...leg, odds: '2' }, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a payout lowered as the odds rose',
      terms: { potentialPayout: '29', legs: [moved, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a raised payout at odds only rewritten',
      terms: { potentialPayout: '36', legs: [{ ...leg, odds: '2.50' }, second] },
      fields: ['potentialPayout'],
    },
    {
      why: 'a payout kept while the odds rose below the money scale',
      terms: {
        potentialPayout: '30',
        legs: [{ ...leg, odds: '2.5000000000000000001' }, second],
      },
      fields: ['potentialPayout'],
    },
    {
      why: 'a leg that drops its odds',
      terms: {
        potentialPayout: '30',
        legs: [{ eventId: 'event-1', market: '1x2', selection: 'home', startsAt }, second],
      },
      fields: ['legs'],
    },
    { why: 'a payout without its legs', terms: { potentialPayout: '36' }, fields: ['legs'] },
    {
      why: 'legs without their payout',
      terms: { legs: [moved, second] },
      fields: ['potentialPayout'],
    },
  ])('refuses $why, keeps the bet reserved and files it', async ({ terms, fields }) => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);

    expect(await confirm(args.providerBetId, terms)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await betRow(betId)).toMatchObject({
      status: 'reserved',
      potentialPayout: '30.000000000000000000',
      legs: [leg, second],
    });
    expect((await transactions(betId)).map((t) => t.kind)).toEqual(['reserve']);
    const filed = await findings(betId);
    expect(filed.map((f) => f.kind)).toEqual(['invalid_amount']);
    expect(filed[0]!.detail).toMatchObject({ fields });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });

  it('accepts unchanged terms with a leg start time given in another offset', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    const shifted = new Date(startsAt).toISOString().replace('Z', '+00:00');
    const legs = [{ ...leg, startsAt: shifted }, second];
    expectApplied(await confirm(args.providerBetId, { potentialPayout: '30', legs }));
    expect(await betRow(betId)).toMatchObject({
      status: 'accepted',
      potentialPayout: '30.000000000000000000',
    });
    expect(await acceptedAudit(betId)).toMatchObject({ legs });
  });

  it('accepts odds only rewritten when the payout holds', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    const legs = [{ ...leg, odds: '2.50' }, second];
    expectApplied(await confirm(args.providerBetId, { potentialPayout: '30', legs }));
    expect(await betRow(betId)).toMatchObject({
      status: 'accepted',
      potentialPayout: '30.000000000000000000',
    });
  });

  it('lets the payout move either way when the odds are not decimals', async () => {
    const player = await fundedPlayer(app, '100');
    const fractional = { ...leg, odds: '3/2' };
    const args = reserveArgs(player.sessionId, {
      stake: '10',
      potentialPayout: '25',
      legs: [fractional],
    });
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    expectApplied(
      await confirm(args.providerBetId, {
        potentialPayout: '30',
        legs: [{ ...fractional, odds: '1/1' }],
      }),
    );
    expect((await betRow(betId!)).potentialPayout).toBe('30.000000000000000000');
  });

  it('refuses terms for a bet already accepted as a transition, not as an amount', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    expectApplied(await confirm(args.providerBetId, {}));
    expect(
      await confirm(args.providerBetId, { potentialPayout: '1000', legs: [leg, second] }),
    ).toEqual({ status: 'refused', reason: 'illegal_transition' });
    expect((await betRow(betId)).potentialPayout).toBe('30.000000000000000000');
    expect((await findings(betId)).map((f) => f.kind)).toEqual(['provider_mismatch']);
  });

  it('refuses a reserve whose potential payout is below the stake', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, { stake: '10', potentialPayout: '9.99' });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
    expect(await findingsByKey(`invalid_amount:${PROVIDER}:${args.providerTxId}`)).toHaveLength(1);
  });

  it('replays a retried confirm with the same terms and refuses one with different terms', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await reserved(player);
    const request = {
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: args.providerBetId,
      potentialPayout: '36',
      legs: [{ ...leg, odds: '3' }, second],
    };
    expectApplied(await ledgerOf(app).confirm(request));

    expect(expectApplied(await ledgerOf(app).confirm(request))).toMatchObject({
      status: 'replayed',
      betId,
      betStatus: 'accepted',
    });
    expect(
      await ledgerOf(app).confirm({
        ...request,
        potentialPayout: '33',
        legs: [{ ...leg, odds: '2.75' }, second],
      }),
    ).toEqual({ status: 'refused', reason: 'fingerprint_mismatch' });
    const bare = {
      provider: PROVIDER,
      providerTxId: request.providerTxId,
      providerBetId: request.providerBetId,
    };
    expect(await ledgerOf(app).confirm(bare)).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });

    expect((await betRow(betId)).potentialPayout).toBe('36.000000000000000000');
    expect((await transactions(betId)).map((t) => t.kind)).toEqual(['reserve', 'confirm']);
    expect(
      await findingsByKey(`fingerprint_mismatch:${PROVIDER}:${request.providerTxId}`),
    ).toHaveLength(1);
  });
});

describe('provider disagreement', () => {
  it('moves nothing when an align would reverse a win it then cannot re-settle', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    expectApplied(await settleWon(args.providerBetId, '25'));
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'void',
      payout: '0',
    });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: [] });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 1, result: 'won' });
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
    expect((await findings(betId)).map((f) => f.kind)).toEqual(['provider_mismatch']);
  });

  it('writes one audit row for an aligned step, not a second one from its event', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    const actions = async () =>
      (
        await app.container
          .get(DRIZZLE)
          .db.select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.resourceId, betId))
      ).map((r) => r.action);
    await vi.waitFor(async () => expect(await actions()).toContain('sportsbook.bet.accepted'));
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '25',
    });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await res.json()).toMatchObject({ applied: ['settle'] });
    const control = await acceptedBet(app, player);
    expectApplied(await settleWon(control.args.providerBetId, '25'));
    await vi.waitFor(async () => {
      const rows = await app.container
        .get(DRIZZLE)
        .db.select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.resourceId, control.betId));
      expect(rows.map((r) => r.action)).toContain('sportsbook.bet.settled');
    });
    expect(
      (await actions()).filter(
        (a) =>
          a.startsWith('sportsbook.bet.') &&
          a !== 'sportsbook.bet.placed' &&
          a !== 'sportsbook.bet.accepted',
      ),
    ).toEqual(['sportsbook.bet.aligned']);
  });

  it('files a late provider callback on a bet core already moved', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    expectApplied(
      await ledgerOf(app).cancel({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        reason: 'rejected',
      }),
    );
    expect(
      await ledgerOf(app).confirm({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
      }),
    ).toEqual({ status: 'refused', reason: 'illegal_transition' });
    expect((await findings(betId!)).map((f) => f.kind)).toEqual(['provider_mismatch']);
  });

  it('leaves the hold state to the wallet audit, placed with the debt and released when it clears', async () => {
    const player = await fundedPlayer(app, '100');
    const first = await acceptedBet(app, player);
    expectApplied(await settleWon(first.args.providerBetId, '25'));
    const second = await acceptedBet(app, player, { stake: '115', potentialPayout: '230' });
    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: first.args.providerBetId,
      }),
    );
    expectApplied(await settleWon(second.args.providerBetId, '230'));

    const debt = await debtOf(player);
    const db = app.container.get(DRIZZLE).db;
    const debtEntries = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sportsbook.debt.changed'), eq(auditLog.resourceId, debt!.id)))
      .orderBy(auditLog.createdAt);
    expect(debtEntries).toHaveLength(2);
    for (const entry of debtEntries) {
      expect(entry.before ?? {}).not.toHaveProperty('holdActive');
      expect(entry.after).not.toHaveProperty('holdActive');
    }
    const [profile] = await db
      .select({ id: playerProfile.id })
      .from(playerProfile)
      .where(eq(playerProfile.userId, player.userId));
    const [placed, released, ...rest] = await db
      .select({ action: auditLog.action, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resourceType, 'player'),
          eq(auditLog.resourceId, profile!.id),
          like(auditLog.action, 'wallet.withdrawal_hold.%'),
        ),
      )
      .orderBy(auditLog.createdAt);
    expect(rest).toEqual([]);
    expect(placed).toMatchObject({
      action: 'wallet.withdrawal_hold.placed',
      before: null,
      after: { userId: player.userId, source: betting.SPORTSBOOK_HOLD_SOURCE },
    });
    expect(released).toMatchObject({
      action: 'wallet.withdrawal_hold.released',
      before: {
        holdId: placed!.after!['holdId'],
        userId: player.userId,
        source: betting.SPORTSBOOK_HOLD_SOURCE,
      },
      after: null,
    });
  });
});

function settleWon(providerBetId: string, payout: string) {
  return ledgerOf(app).settle({
    provider: PROVIDER,
    providerTxId: txId(),
    providerBetId,
    result: 'won',
    payout,
  });
}

async function debtOf(player: SportsbookPlayer) {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select()
    .from(sportsbookPlayerDebt)
    .where(eq(sportsbookPlayerDebt.userId, player.userId));
  return row;
}

const holdsOf = (player: SportsbookPlayer) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(walletWithdrawalHold)
    .where(eq(walletWithdrawalHold.userId, player.userId));

async function adminCall(res: Promise<Response>) {
  const r = await res;
  if (r.status !== 200) {
    throw new Error(`admin call failed (${r.status}): ${await r.text()}`);
  }
}

const restrict = (userId: string) =>
  adminCall(
    admin.post(`/backoffice/sportsbook/players/${userId}/restriction`, {
      reason: 'test restriction',
    }),
  );
const lift = (userId: string) =>
  adminCall(
    admin.request(`/backoffice/sportsbook/players/${userId}/restriction`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test lift' }),
    }),
  );
const suspend = () =>
  adminCall(admin.post('/backoffice/sportsbook/suspend', { reason: 'test suspension' }));
const resume = () =>
  adminCall(admin.post('/backoffice/sportsbook/resume', { reason: 'test resume' }));
