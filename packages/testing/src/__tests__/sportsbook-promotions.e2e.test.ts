import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, gt } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { EXCHANGE_RATE_READER, type SportsbookReserveArgs } from '@openora/core/contracts';
import { promoPlayerRank, promoStreakDailyWager } from '@openora/core/promo/schema/gamification';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookPlayerDebt,
  sportsbookReconciliationFinding,
  sportsbookSession,
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

type Promotion = NonNullable<SportsbookReserveArgs['promotion']>;

const PROMOTIONS = {
  enabled: true,
  maxPromotionStakeUsd: '50',
  funder: { freebet: 'provider' },
} as const;

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app, { promotions: PROMOTIONS });
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const drizzle = () => app.container.get(DRIZZLE).db;

const freebet: Promotion = {
  type: 'freebet',
  id: 'grant-1',
  stake: 'promotion',
  voidReturnsStake: false,
};
const freeMoney: Promotion = { type: 'free-money', stake: 'promotion', voidReturnsStake: true };
const noRisk: Promotion = { type: 'no-risk', id: 'grant-2', stake: 'player', refundsLoss: true };
const boost: Promotion = {
  type: 'boost',
  stake: 'player',
  refundsLoss: false,
  potentialAmount: '5',
};

async function betRow(betId: string) {
  const [row] = await drizzle().select().from(sportsbookBet).where(eq(sportsbookBet.id, betId));
  return row!;
}

const betsFor = (providerBetId: string) =>
  drizzle().select().from(sportsbookBet).where(eq(sportsbookBet.providerBetId, providerBetId));

const txRows = (providerBetId: string) =>
  drizzle()
    .select()
    .from(sportsbookBetTransaction)
    .where(eq(sportsbookBetTransaction.providerBetId, providerBetId))
    .orderBy(sportsbookBetTransaction.createdAt);

const ledgerRows = async (userId: string) =>
  (
    await drizzle()
      .select({ type: walletTransaction.type, amount: walletTransaction.amount })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.providerName, `sportsbook:${PROVIDER}`),
        ),
      )
      .orderBy(walletTransaction.createdAt)
  ).map((r) => `${r.type} ${r.amount}`);

const walletsOf = (userId: string) =>
  drizzle().select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, userId));

const findingKinds = async (betId: string) =>
  (
    await drizzle()
      .select({ kind: sportsbookReconciliationFinding.kind })
      .from(sportsbookReconciliationFinding)
      .where(eq(sportsbookReconciliationFinding.betId, betId))
  ).map((f) => f.kind);

const money = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(18, '0')}`;
};

function settle(
  providerBetId: string,
  result: 'won' | 'lost' | 'void' | 'half_won' | 'half_lost' | 'cashed_out',
  payout: string,
  extra: { promotionAmount?: string } = {},
) {
  return ledgerOf(app).settle({
    provider: PROVIDER,
    providerTxId: txId(),
    providerBetId,
    result,
    payout,
    ...extra,
  });
}

const reopen = (providerBetId: string) =>
  ledgerOf(app).reopen({ provider: PROVIDER, providerTxId: txId(), providerBetId });

async function adminCall(res: Promise<Response>) {
  const r = await res;
  if (r.status !== 200) {
    throw new Error(`admin call failed (${r.status}): ${await r.text()}`);
  }
  return r;
}

describe('promotion-paid stakes', () => {
  it('takes no stake from the balance and books no wallet row on reserve', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '5',
      potentialPayout: '25',
      promotion: freebet,
    });
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([]);
    expect(await betRow(betId)).toMatchObject({
      stake: money('5'),
      cashStake: money('0'),
      voidPayout: money('0'),
      maxLossRefund: money('0'),
      promotionType: 'freebet',
      promotionId: 'grant-1',
    });
    const [reserve] = await txRows(args.providerBetId);
    expect(reserve).toMatchObject({ kind: 'reserve', walletTransactionIds: [] });
  });

  it('accepts a reserve from a player whose balance is spent', async () => {
    const player = await fundedPlayer(app, '5');
    await acceptedBet(app, player, { stake: '5' });
    expectApplied(
      await ledgerOf(app).reserve(
        reserveArgs(player.sessionId, { stake: '5', promotion: freebet }),
      ),
    );
    expect(await balanceOf(app, player.userId)).toBe(money('0'));
  });

  it('refuses a reserve from a player with no wallet, as a cash reserve is', async () => {
    const player = await fundedPlayer(app, '0');
    expect(await walletsOf(player.userId)).toEqual([]);
    const args = reserveArgs(player.sessionId, { stake: '5', promotion: freebet });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'insufficient_funds',
    });
    expect(await betsFor(args.providerBetId)).toEqual([]);
  });

  it('returns nothing on a cancel', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, { stake: '5', promotion: freebet });
    expectApplied(await ledgerOf(app).reserve(args));
    const cancelled = expectApplied(
      await ledgerOf(app).cancel({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        reason: 'rejected',
      }),
    );
    expect(cancelled.betStatus).toBe('cancelled');
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([]);
  });

  it('pays nothing on a void that does not return the stake, and refuses a void that would', async () => {
    const player = await fundedPlayer(app, '100');
    const voided = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(voided.args.providerBetId, 'void', '0'));
    expect(await betRow(voided.betId)).toMatchObject({ status: 'settled', result: 'void' });
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([]);

    const refused = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expect(await settle(refused.args.providerBetId, 'void', '5')).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(refused.betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('pays a void that returns the stake as a win and takes it back as a win reversal', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freeMoney });
    expectApplied(await settle(args.providerBetId, 'void', '5'));
    expect(await balanceOf(app, player.userId)).toBe(money('105'));
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('5') });

    expectApplied(await reopen(args.providerBetId));
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([
      `win ${money('5')}`,
      `win_reversal ${money('5')}`,
    ]);
    expect(await betRow(betId)).toMatchObject({ status: 'accepted', promotionPaid: money('0') });
  });

  it('books a void that returns the stake at 0 when the provider re-grants it, and refuses any other amount', async () => {
    const player = await fundedPlayer(app, '100');
    const regranted = await acceptedBet(app, player, { stake: '5', promotion: freeMoney });
    expectApplied(await settle(regranted.args.providerBetId, 'void', '0'));
    expect(await betRow(regranted.betId)).toMatchObject({
      status: 'settled',
      result: 'void',
      payoutTotal: money('0'),
      promotionPaid: money('0'),
    });
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([]);

    const refused = await acceptedBet(app, player, { stake: '5', promotion: freeMoney });
    expect(await settle(refused.args.providerBetId, 'void', '2.50')).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(refused.betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('credits a win in full and takes it back in full on reopen', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'won', '12.50'));
    expect(await balanceOf(app, player.userId)).toBe(money('112.5'));
    expect(await betRow(betId)).toMatchObject({
      payoutTotal: money('12.5'),
      promotionPaid: money('12.5'),
    });
    const settleRow = (await txRows(args.providerBetId)).find((r) => r.kind === 'settle');
    expect(settleRow).toMatchObject({ amount: money('12.5'), promotionAmount: money('12.5') });

    expectApplied(await reopen(args.providerBetId));
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([
      `win ${money('12.5')}`,
      `win_reversal ${money('12.5')}`,
    ]);
  });

  it('turns what a reopen cannot collect into debt and a hold', async () => {
    const player = await fundedPlayer(app, '4');
    const freebetBet = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(freebetBet.args.providerBetId, 'won', '12.50'));
    await acceptedBet(app, player, { stake: '12.50', potentialPayout: '30' });
    expect(await balanceOf(app, player.userId)).toBe(money('4'));

    expectApplied(await reopen(freebetBet.args.providerBetId));
    expect(await balanceOf(app, player.userId)).toBe(money('0'));
    const [debt] = await drizzle()
      .select()
      .from(sportsbookPlayerDebt)
      .where(eq(sportsbookPlayerDebt.userId, player.userId));
    expect(debt).toMatchObject({ owed: money('8.5'), outstanding: money('8.5') });
    const holds = await drizzle()
      .select()
      .from(walletWithdrawalHold)
      .where(eq(walletWithdrawalHold.userId, player.userId));
    expect(holds).toHaveLength(1);
  });

  it('pays a half lost and records it as promotion paid', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'half_lost', '2.50'));
    expect(await balanceOf(app, player.userId)).toBe(money('102.5'));
    expect(await betRow(betId)).toMatchObject({
      payoutTotal: money('2.5'),
      promotionPaid: money('2.5'),
    });
  });

  it('files a payout above the stake times the leg odds', async () => {
    const player = await fundedPlayer(app, '100');
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const legs = [
      { eventId: 'event-1', startsAt, odds: '2.5' },
      { eventId: 'event-2', startsAt, odds: '1.2' },
    ];
    const fair = await acceptedBet(app, player, {
      stake: '5',
      potentialPayout: '20',
      legs,
      promotion: freebet,
    });
    expectApplied(await settle(fair.args.providerBetId, 'won', '15'));
    expect(await findingKinds(fair.betId)).toEqual([]);

    const unusual = await acceptedBet(app, player, {
      stake: '5',
      potentialPayout: '20',
      legs,
      promotion: freebet,
    });
    expectApplied(await settle(unusual.args.providerBetId, 'won', '15.01'));
    expect(await findingKinds(unusual.betId)).toEqual(['promotion_payout_unusual']);
  });
});

describe('player-paid stakes with a loss refund', () => {
  it('pays a refund on a loss as a win', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: noRisk });
    expect(await balanceOf(app, player.userId)).toBe(money('95'));
    expect(await betRow(betId)).toMatchObject({
      cashStake: money('5'),
      voidPayout: money('5'),
      maxLossRefund: money('5'),
    });
    expectApplied(await settle(args.providerBetId, 'lost', '5'));
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([`bet ${money('5')}`, `win ${money('5')}`]);
    expect(await betRow(betId)).toMatchObject({ result: 'lost', promotionPaid: money('5') });
  });

  it('refuses a refund above the stake', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: noRisk });
    expect(await settle(args.providerBetId, 'lost', '6')).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(betId)).status).toBe('accepted');
  });

  it('refuses a refund on a bet that declared none', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, { stake: '5', promotion: boost });
    expect(await settle(args.providerBetId, 'lost', '5')).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
  });

  it('stores the promotion part a half lost names', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '10', promotion: noRisk });
    expectApplied(await settle(args.providerBetId, 'half_lost', '5', { promotionAmount: '2.50' }));
    expect(await betRow(betId)).toMatchObject({
      payoutTotal: money('5'),
      promotionPaid: money('2.5'),
    });
  });

  it('takes a refund back as a win reversal on reopen', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: noRisk });
    expectApplied(await settle(args.providerBetId, 'lost', '5'));
    expectApplied(await reopen(args.providerBetId));
    expect(await balanceOf(app, player.userId)).toBe(money('95'));
    expect(await ledgerRows(player.userId)).toEqual([
      `bet ${money('5')}`,
      `win ${money('5')}`,
      `win_reversal ${money('5')}`,
    ]);
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('0') });
  });
});

describe('boosted payouts', () => {
  it('credits the full boosted payout and stores the boost part', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '10',
      potentialPayout: '30',
      promotion: boost,
    });
    expect(await betRow(betId)).toMatchObject({ promotionPotential: money('5') });
    expectApplied(await settle(args.providerBetId, 'won', '30', { promotionAmount: '5' }));
    expect(await balanceOf(app, player.userId)).toBe(money('120'));
    expect(await ledgerRows(player.userId)).toEqual([`bet ${money('10')}`, `win ${money('30')}`]);
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('5') });
  });

  it('refuses a promotion part above the payout', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '10',
      potentialPayout: '30',
      promotion: boost,
    });
    expect(await settle(args.providerBetId, 'won', '30', { promotionAmount: '31' })).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('90'));
  });

  it('stores the boost part a half loss names', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '10',
      potentialPayout: '30',
      promotion: boost,
    });
    expectApplied(await settle(args.providerBetId, 'half_lost', '7', { promotionAmount: '2' }));
    expect(await betRow(betId)).toMatchObject({
      payoutTotal: money('7'),
      promotionPaid: money('2'),
    });
  });

  it('stores the boost part when the settle leaves it out', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '10',
      potentialPayout: '30',
      promotion: boost,
    });
    expectApplied(await settle(args.providerBetId, 'won', '30'));
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('5') });
  });

  it.each([
    { why: 'above the boost on a win', result: 'won', payout: '30', promotionAmount: '6' },
    {
      why: 'on a void of a player-paid stake',
      result: 'void',
      payout: '10',
      promotionAmount: '10',
    },
  ] as const)('refuses a promotion part $why', async ({ result, payout, promotionAmount }) => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      stake: '10',
      potentialPayout: '30',
      promotion: boost,
    });
    expect(await settle(args.providerBetId, result, payout, { promotionAmount })).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('90'));
  });
});

describe('accepted terms on a promotion bet', () => {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  const leg = (odds: string) => ({ eventId: 'event-1', startsAt, odds });

  const confirmTerms = (
    providerBetId: string,
    terms: {
      potentialPayout?: string;
      legs?: ReturnType<typeof leg>[];
      promotionPotential?: string;
    },
  ) => ledgerOf(app).confirm({ provider: PROVIDER, providerTxId: txId(), providerBetId, ...terms });

  async function reservedBet(overrides: Partial<SportsbookReserveArgs>) {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, overrides);
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    return { args, betId: betId! };
  }

  const refusedFields = async (betId: string) =>
    (
      await drizzle()
        .select({ detail: sportsbookReconciliationFinding.detail })
        .from(sportsbookReconciliationFinding)
        .where(eq(sportsbookReconciliationFinding.betId, betId))
    ).map((f) => (f.detail as { fields?: string[] }).fields);

  it('reserves and accepts a free bet that pays less than its stake', async () => {
    const { args, betId } = await reservedBet({
      stake: '10',
      potentialPayout: '5',
      legs: [leg('1.5')],
      promotion: freebet,
    });
    expectApplied(
      await confirmTerms(args.providerBetId, { potentialPayout: '4', legs: [leg('1.4')] }),
    );
    expect(await betRow(betId)).toMatchObject({
      status: 'accepted',
      potentialPayout: money('4'),
    });
  });

  it('refuses a player-paid promotion that pays less than its stake', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, {
      stake: '10',
      potentialPayout: '5',
      legs: [leg('1.5')],
      promotion: noRisk,
    });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await betsFor(args.providerBetId)).toEqual([]);
  });

  it('moves the boost part with the odds the provider accepted', async () => {
    const { args, betId } = await reservedBet({
      stake: '10',
      potentialPayout: '30',
      legs: [leg('3')],
      promotion: boost,
    });
    expectApplied(
      await confirmTerms(args.providerBetId, {
        potentialPayout: '25',
        legs: [leg('2.5')],
        promotionPotential: '4',
      }),
    );
    expect(await betRow(betId)).toMatchObject({
      potentialPayout: money('25'),
      promotionPotential: money('4'),
    });
    const [, confirmRow] = await txRows(args.providerBetId);
    expect(confirmRow).toMatchObject({ kind: 'confirm', promotionPotential: money('4') });
  });

  it.each([
    {
      why: 'a stored boost part the new payout no longer covers',
      potentialAmount: '20',
      terms: { potentialPayout: '15', legs: [leg('1.5')] },
    },
    {
      why: 'a boost part above the new payout',
      potentialAmount: '5',
      terms: { potentialPayout: '25', legs: [leg('2.5')], promotionPotential: '26' },
    },
    {
      why: 'a boost part without the terms',
      potentialAmount: '5',
      terms: { promotionPotential: '4' },
    },
    {
      why: 'a changed boost part at unchanged odds',
      potentialAmount: '5',
      terms: { potentialPayout: '30', legs: [leg('3')], promotionPotential: '4' },
    },
  ])('refuses $why and keeps the bet reserved', async ({ potentialAmount, terms }) => {
    const { args, betId } = await reservedBet({
      stake: '10',
      potentialPayout: '30',
      legs: [leg('3')],
      promotion: { ...boost, potentialAmount },
    });
    expect(await confirmTerms(args.providerBetId, terms)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await betRow(betId)).toMatchObject({
      status: 'reserved',
      potentialPayout: money('30'),
      promotionPotential: money(potentialAmount),
    });
    expect(await refusedFields(betId)).toEqual([['promotionPotential']]);
  });

  it.each(['-1', '1.0000000000000000001'])(
    'refuses a malformed boost part %s as an amount and files it',
    async (promotionPotential) => {
      const { args, betId } = await reservedBet({
        stake: '10',
        potentialPayout: '30',
        legs: [leg('3')],
        promotion: boost,
      });
      const providerTxId = txId();
      expect(
        await ledgerOf(app).confirm({
          provider: PROVIDER,
          providerTxId,
          providerBetId: args.providerBetId,
          potentialPayout: '25',
          legs: [leg('2.5')],
          promotionPotential,
        }),
      ).toEqual({ status: 'refused', reason: 'invalid_amount' });
      expect((await betRow(betId)).status).toBe('reserved');
      expect(await findingsFor(providerTxId)).toEqual(['invalid_amount']);
    },
  );

  it('refuses a boost part on a bet that declared no promotion', async () => {
    const { args, betId } = await reservedBet({ potentialPayout: '30', legs: [leg('3')] });
    expect(
      await confirmTerms(args.providerBetId, {
        potentialPayout: '25',
        legs: [leg('2.5')],
        promotionPotential: '4',
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_amount' });
    expect((await betRow(betId)).status).toBe('reserved');
    expect(await refusedFields(betId)).toEqual([['promotionPotential']]);
  });
});

const findingsFor = async (providerTxId: string) =>
  (
    await drizzle()
      .select({ kind: sportsbookReconciliationFinding.kind })
      .from(sportsbookReconciliationFinding)
      .where(
        eq(sportsbookReconciliationFinding.dedupeKey, `invalid_amount:${PROVIDER}:${providerTxId}`),
      )
  ).map((f) => f.kind);

describe('promotion attribution', () => {
  it('refuses and files a promotion part on a bet that declared no promotion', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', potentialPayout: '25' });
    const providerTxId = txId();
    expect(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId,
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '10',
        promotionAmount: '2',
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_amount' });
    expect(await findingsFor(providerTxId)).toEqual(['invalid_amount']);
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('95'));

    expectApplied(await settle(args.providerBetId, 'won', '10', { promotionAmount: '0' }));
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('0') });
  });

  it('refuses and files a promotion part that is not the whole promotion-paid payout', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    const providerTxId = txId();
    expect(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId,
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '12.50',
        promotionAmount: '10',
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_amount' });
    expect(await findingsFor(providerTxId)).toEqual(['invalid_amount']);
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money('100'));

    expectApplied(await settle(args.providerBetId, 'won', '12.50', { promotionAmount: '12.5' }));
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('12.5') });
  });

  it.each([
    { why: 'more decimals than the currency', potentialAmount: '5.001' },
    { why: 'more than the potential payout', potentialAmount: '25.01' },
  ])('refuses and files a potential amount with $why', async ({ potentialAmount }) => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, {
      stake: '5',
      potentialPayout: '25',
      promotion: { ...boost, potentialAmount },
    });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await findingsFor(args.providerTxId)).toEqual(['invalid_amount']);
    expect(await betsFor(args.providerBetId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
    expect(await ledgerRows(player.userId)).toEqual([]);
  });
});

describe('refused declarations', () => {
  it.each([
    {
      why: 'a promotion-paid stake that also refunds a loss',
      promotion: { ...freebet, refundsLoss: true },
    },
    { why: 'an unknown key', promotion: { ...noRisk, cashShare: '2' } },
    { why: 'no stake owner', promotion: { type: 'freebet', voidReturnsStake: false } },
    { why: 'a type the funder map cannot hold', promotion: { ...freebet, type: '__proto__' } },
  ])('refuses $why and books nothing', async ({ promotion }) => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, {
      stake: '5',
      promotion: promotion as unknown as Promotion,
    });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'promotion_not_allowed',
    });
    expect(await betsFor(args.providerBetId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('throws when a bad declaration comes with another malformed field', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, {
      stake: '5',
      promotion: { ...freebet, refundsLoss: true } as unknown as Promotion,
    });
    await expect(ledgerOf(app).reserve({ ...args, providerBetId: '' })).rejects.toThrow();
    expect(await betsFor(args.providerBetId)).toEqual([]);
  });

  it.each(['-1', 'abc'])(
    'refuses a malformed boost potential %s as an amount and files it',
    async (potentialAmount) => {
      const player = await fundedPlayer(app, '100');
      const args = reserveArgs(player.sessionId, {
        stake: '5',
        promotion: { ...boost, potentialAmount },
      });
      expect(await ledgerOf(app).reserve(args)).toEqual({
        status: 'refused',
        reason: 'invalid_amount',
      });
      expect(await findingsFor(args.providerTxId)).toEqual(['invalid_amount']);
      expect(await betsFor(args.providerBetId)).toEqual([]);
    },
  );

  it.each([
    { kind: 'cooling-off', path: '/compliance/rg/cooling-off', body: { durationHours: 24 } },
    {
      kind: 'self-exclusion',
      path: '/compliance/rg/self-exclusion',
      body: { isPermanent: true, confirm: true },
    },
  ])('refuses a promotion-paid stake after $kind', async ({ path, body }) => {
    const player = await fundedPlayer(app, '100');
    expect((await player.client.post(path, body)).status).toBe(200);
    await vi.waitFor(
      async () => {
        const [session] = await drizzle()
          .select({ revokedAt: sportsbookSession.revokedAt })
          .from(sportsbookSession)
          .where(eq(sportsbookSession.id, player.sessionId));
        expect(session?.revokedAt).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: null })
      .where(eq(sportsbookSession.id, player.sessionId));

    const args = reserveArgs(player.sessionId, { stake: '5', promotion: freebet });
    expect(await ledgerOf(app).reserve(args)).toEqual({
      status: 'refused',
      reason: 'player_blocked',
    });
    expect(await betsFor(args.providerBetId)).toEqual([]);
  });

  it('refuses a promotion-paid stake above the USD cap, but not a player-paid one', async () => {
    const player = await fundedPlayer(app, '100');
    const over = reserveArgs(player.sessionId, {
      stake: '50.01',
      potentialPayout: '200',
      promotion: freebet,
    });
    expect(await ledgerOf(app).reserve(over)).toEqual({
      status: 'refused',
      reason: 'promotion_not_allowed',
    });
    expect(await betsFor(over.providerBetId)).toEqual([]);
    expectApplied(
      await ledgerOf(app).reserve(
        reserveArgs(player.sessionId, { stake: '50', potentialPayout: '200', promotion: freebet }),
      ),
    );
    expectApplied(
      await ledgerOf(app).reserve(
        reserveArgs(player.sessionId, { stake: '60', potentialPayout: '200', promotion: noRisk }),
      ),
    );
  });

  it('values a promotion-paid stake in another currency in USD against the cap', async () => {
    const player = await fundedPlayer(app, '100', 'EUR');
    const eur = (stake: string) =>
      reserveArgs(player.sessionId, {
        currency: 'EUR',
        stake,
        potentialPayout: '200',
        promotion: freebet,
      });
    const over = eur('25.01');
    expect(await ledgerOf(app).reserve(over)).toEqual({
      status: 'refused',
      reason: 'promotion_not_allowed',
    });
    expect(await betsFor(over.providerBetId)).toEqual([]);
    expectApplied(await ledgerOf(app).reserve(eur('25')));
  });

  it('refuses a promotion-paid stake under a cap when it has no USD rate', async () => {
    const player = await fundedPlayer(app, '100', 'EUR');
    const getRate = vi.spyOn(app.container.get(EXCHANGE_RATE_READER), 'getRate');
    getRate.mockResolvedValue(null);
    try {
      const args = reserveArgs(player.sessionId, {
        currency: 'EUR',
        stake: '1',
        promotion: freebet,
      });
      expect(await ledgerOf(app).reserve(args)).toEqual({
        status: 'refused',
        reason: 'promotion_not_allowed',
      });
      expect(await betsFor(args.providerBetId)).toEqual([]);
    } finally {
      getRate.mockRestore();
    }
  });

  it('refuses a promotion-paid stake whose USD value is below the smallest amount over a zero cap', async () => {
    await enableSportsbook(
      app,
      { promotions: { ...PROMOTIONS, maxPromotionStakeUsd: '0' } },
      admin,
    );
    const player = await fundedPlayer(app, '100', 'EUR');
    const getRate = vi.spyOn(app.container.get(EXCHANGE_RATE_READER), 'getRate');
    getRate.mockResolvedValue({ rate: '0.000000000000000099', asOf: new Date().toISOString() });
    try {
      const args = reserveArgs(player.sessionId, {
        currency: 'EUR',
        stake: '0.01',
        promotion: freebet,
      });
      expect(await ledgerOf(app).reserve(args)).toEqual({
        status: 'refused',
        reason: 'promotion_not_allowed',
      });
    } finally {
      getRate.mockRestore();
      await enableSportsbook(app, { promotions: PROMOTIONS }, admin);
    }
  });

  it('applies any promotion-paid stake without pricing it while there is no cap', async () => {
    await enableSportsbook(
      app,
      { promotions: { ...PROMOTIONS, maxPromotionStakeUsd: null } },
      admin,
    );
    const player = await fundedPlayer(app, '100', 'EUR');
    const getRate = vi.spyOn(app.container.get(EXCHANGE_RATE_READER), 'getRate');
    try {
      expectApplied(
        await ledgerOf(app).reserve(
          reserveArgs(player.sessionId, {
            currency: 'EUR',
            stake: '500',
            potentialPayout: '2000',
            promotion: freebet,
          }),
        ),
      );
      expect(getRate).not.toHaveBeenCalledWith('EUR', 'USD');
    } finally {
      getRate.mockRestore();
      await enableSportsbook(app, { promotions: PROMOTIONS }, admin);
    }
  });

  it('refuses every promotion while promotions are off', async () => {
    const player = await fundedPlayer(app, '100');
    await enableSportsbook(app, { promotions: { ...PROMOTIONS, enabled: false } }, admin);
    try {
      for (const promotion of [freebet, noRisk]) {
        const args = reserveArgs(player.sessionId, { stake: '5', promotion });
        expect(await ledgerOf(app).reserve(args)).toEqual({
          status: 'refused',
          reason: 'promotion_not_allowed',
        });
        expect(await betsFor(args.providerBetId)).toEqual([]);
      }
      expectApplied(await ledgerOf(app).reserve(reserveArgs(player.sessionId)));
    } finally {
      await enableSportsbook(app, { promotions: PROMOTIONS }, admin);
    }
    expect(await balanceOf(app, player.userId)).toBe(money('90'));
  });

  it('reads back settings a client can write unchanged', async () => {
    const res = await admin.get('/backoffice/sportsbook/config');
    expect(res.status).toBe(200);
    const { suspended, updatedAt, ...config } = (await res.json()) as Record<string, unknown>;
    expect([suspended, typeof updatedAt]).toEqual([false, 'string']);
    expect(config['promotions']).toEqual(PROMOTIONS);
    expect((await admin.put('/backoffice/sportsbook/config', config)).status).toBe(200);
  });

  it('refuses promotion settings that leave the cap out, and keeps the cap', async () => {
    const res = await admin.put('/backoffice/sportsbook/config', {
      enabled: true,
      currencies: [{ currency: 'USD', decimals: 2 }],
      blockedCountries: [],
      reserveTimeoutSeconds: 30,
      settlementGraceMinutes: 10,
      sessionTtlMinutes: 60,
      promotions: { enabled: true, funder: {} },
    });
    expect(res.status).toBe(400);
    const player = await fundedPlayer(app, '100');
    const over = reserveArgs(player.sessionId, {
      stake: '50.01',
      potentialPayout: '200',
      promotion: freebet,
    });
    expect(await ledgerOf(app).reserve(over)).toEqual({
      status: 'refused',
      reason: 'promotion_not_allowed',
    });
  });
});

describe('bet row checks', () => {
  const violation = (constraint: string) => ({
    cause: expect.objectContaining({ constraint }),
  });

  const breakRow = (betId: string, change: Partial<typeof sportsbookBet.$inferInsert>) =>
    drizzle().update(sportsbookBet).set(change).where(eq(sportsbookBet.id, betId));

  it('refuses a stake split between the player and a promotion, or unpaid without one', async () => {
    const player = await fundedPlayer(app, '100');
    const promo = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    const plain = await acceptedBet(app, player, { stake: '5' });
    await expect(breakRow(promo.betId, { cashStake: '2' })).rejects.toMatchObject(
      violation('sportsbook_bet_cash_stake_check'),
    );
    await expect(breakRow(plain.betId, { cashStake: '0', voidPayout: '0' })).rejects.toMatchObject(
      violation('sportsbook_bet_cash_stake_check'),
    );
  });

  it('refuses a loss refund or a promotion part on a bet with no promotion', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5' });
    await expect(breakRow(betId, { maxLossRefund: '5' })).rejects.toMatchObject(
      violation('sportsbook_bet_max_loss_refund_check'),
    );
    expectApplied(await settle(args.providerBetId, 'won', '12'));
    await expect(breakRow(betId, { promotionPaid: '2' })).rejects.toMatchObject(
      violation('sportsbook_bet_promotion_paid_check'),
    );
  });

  it('refuses a promotion-paid payout the promotion did not wholly fund', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'won', '12.50'));
    await expect(breakRow(betId, { promotionPaid: '2' })).rejects.toMatchObject(
      violation('sportsbook_bet_promotion_paid_check'),
    );
  });

  it('refuses a void or a loss that pays what the declaration does not allow', async () => {
    const player = await fundedPlayer(app, '100');
    const promo = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(promo.args.providerBetId, 'void', '0'));
    await expect(
      breakRow(promo.betId, { payoutTotal: '5', promotionPaid: '5' }),
    ).rejects.toMatchObject(violation('sportsbook_bet_result_payout_check'));
    const regranted = await acceptedBet(app, player, { stake: '5', promotion: freeMoney });
    expectApplied(await settle(regranted.args.providerBetId, 'void', '0'));
    await expect(
      breakRow(regranted.betId, { payoutTotal: '2.5', promotionPaid: '2.5' }),
    ).rejects.toMatchObject(violation('sportsbook_bet_result_payout_check'));
    const plain = await acceptedBet(app, player, { stake: '5' });
    expectApplied(await settle(plain.args.providerBetId, 'void', '5'));
    await expect(breakRow(plain.betId, { payoutTotal: '0' })).rejects.toMatchObject(
      violation('sportsbook_bet_result_payout_check'),
    );
    const refund = await acceptedBet(app, player, { stake: '5', promotion: noRisk });
    expectApplied(await settle(refund.args.providerBetId, 'lost', '5'));
    await expect(
      breakRow(refund.betId, { payoutTotal: '6', promotionPaid: '6' }),
    ).rejects.toMatchObject(violation('sportsbook_bet_result_payout_check'));
  });
});

describe('request fingerprint', () => {
  it('hashes a plain reserve exactly as before', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    expectApplied(await ledgerOf(app).reserve(args));
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'reserve',
          PROVIDER,
          args.providerBetId,
          player.userId,
          money('10'),
          money('25'),
          'USD',
          '',
          '',
          '',
          args.legs.map((leg) => [
            JSON.stringify([leg.eventId, null, null, null, new Date(leg.startsAt).getTime()]),
            null,
          ]),
        ]),
      )
      .digest('hex');
    const [reserve] = await txRows(args.providerBetId);
    expect(reserve!.fingerprint).toBe(expected);
  });

  it.each([
    { why: 'the stake owner', promotion: { type: 'freebet', stake: 'player', refundsLoss: false } },
    { why: 'the void flag', promotion: { ...freebet, voidReturnsStake: true } },
    { why: 'the type', promotion: { ...freebet, type: 'free-money' } },
    { why: 'the id', promotion: { ...freebet, id: 'grant-9' } },
    { why: 'the potential amount', promotion: { ...freebet, potentialAmount: '1' } },
  ])('refuses a retry that changes $why', async ({ promotion }) => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, { stake: '5', promotion: freebet });
    expectApplied(await ledgerOf(app).reserve(args));
    expect(await ledgerOf(app).reserve({ ...args, promotion: promotion as Promotion })).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });
    expect(await ledgerOf(app).reserve(args)).toMatchObject({ status: 'replayed' });
  });

  it('refuses a settle retry that changes the promotion part', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, { promotion: boost, potentialPayout: '30' });
    const settleArgs = {
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: args.providerBetId,
      result: 'won' as const,
      payout: '30',
      promotionAmount: '5',
    };
    expectApplied(await ledgerOf(app).settle(settleArgs));
    expect(await ledgerOf(app).settle({ ...settleArgs, promotionAmount: '4' })).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });
  });
});

describe('align with a promotion-paid bet', () => {
  it('applies a provider void of nothing without a finding', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'void',
      payout: '0',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: ['settle'] });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', result: 'void' });
    expect(await findingKinds(betId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('moves nothing and files a mismatch for a provider void that returns the stake', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'void',
      payout: '5',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await res.json()).toMatchObject({ applied: [] });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await findingKinds(betId)).toEqual(['provider_mismatch']);
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('moves nothing and files a mismatch when a settled bet is re-reported with a bad split', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'won', '12.50'));
    const before = await betRow(betId);
    const ledgerBefore = await ledgerRows(player.userId);
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '15',
      promotionAmount: '10',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: [] });
    expect(await findingKinds(betId)).toEqual(['provider_mismatch']);
    expect(await betRow(betId)).toEqual(before);
    expect(await ledgerRows(player.userId)).toEqual(ledgerBefore);
    expect(await balanceOf(app, player.userId)).toBe(money('112.5'));
  });

  it('leaves a reserved bet unconfirmed when the provider reports a bad split', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId, { stake: '5', promotion: freebet });
    const { betId } = expectApplied(await ledgerOf(app).reserve(args));
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '15',
      promotionAmount: '10',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: [] });
    expect(await findingKinds(betId!)).toEqual(['provider_mismatch']);
    expect((await betRow(betId!)).status).toBe('reserved');
    expect(await balanceOf(app, player.userId)).toBe(money('100'));
  });

  it('applies the promotion part a provider status reports', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      potentialPayout: '30',
      promotion: boost,
    });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '30',
      promotionAmount: '5',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await res.json()).toMatchObject({ applied: ['settle'] });
    expect(await betRow(betId)).toMatchObject({ promotionPaid: money('5') });
  });

  it('moves nothing and files a mismatch when a settled bet is re-reported with another split', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      potentialPayout: '30',
      promotion: boost,
    });
    expectApplied(await settle(args.providerBetId, 'won', '30', { promotionAmount: '5' }));
    const before = await betRow(betId);
    const ledgerBefore = await ledgerRows(player.userId);
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '30',
      promotionAmount: '0',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await res.json()).toMatchObject({ applied: [] });
    expect(await findingKinds(betId)).toEqual(['provider_mismatch']);
    expect(await betRow(betId)).toEqual(before);
    expect(await ledgerRows(player.userId)).toEqual(ledgerBefore);
  });

  it('leaves a settled bet alone when the provider reports the same split', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, {
      potentialPayout: '30',
      promotion: boost,
    });
    expectApplied(await settle(args.providerBetId, 'won', '30', { promotionAmount: '5' }));
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '30',
      promotionAmount: '5.00',
    });
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await res.json()).toMatchObject({ applied: [] });
    expect(await findingKinds(betId)).toEqual([]);
  });
});

describe('responsible gambling', () => {
  async function lossLimitUsed(player: SportsbookPlayer) {
    const res = await player.client.get('/compliance/limits');
    const limits = (await res.json()) as { type: string; used: string | null }[];
    return limits.find((l) => l.type === 'loss')?.used;
  }

  async function withLossLimit(player: SportsbookPlayer) {
    await adminCall(
      admin.put(`/compliance/players/${player.userId}/limits`, {
        type: 'loss',
        amount: '1000',
        minutes: null,
        currency: 'USD',
        period: 'daily',
        reason: 'loss limit for the promotion check',
        confirm: true,
      }),
    );
  }

  it('does not let promotion winnings reduce a cash loss', async () => {
    const player = await fundedPlayer(app, '100');
    await withLossLimit(player);
    const cash = await acceptedBet(app, player, { stake: '10' });
    expectApplied(await settle(cash.args.providerBetId, 'lost', '0'));
    const promo = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(promo.args.providerBetId, 'won', '12.50'));
    expect(await lossLimitUsed(player)).toBe(money('10'));
  });

  it('measures no loss for a player with only promotion wins', async () => {
    const player = await fundedPlayer(app, '100');
    await withLossLimit(player);
    const promo = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(promo.args.providerBetId, 'won', '12.50'));
    expect(await lossLimitUsed(player)).toBe(money('0'));
  });

  it('nets a refunded loss to the stake minus the refund', async () => {
    const player = await fundedPlayer(app, '100');
    await withLossLimit(player);
    const { args } = await acceptedBet(app, player, { stake: '10', promotion: noRisk });
    expectApplied(await settle(args.providerBetId, 'lost', '4'));
    expect(await lossLimitUsed(player)).toBe(money('6'));
  });

  it('counts a cash refund a promotion win paid back toward the loss of the bet that owed it', async () => {
    const player = await fundedPlayer(app, '10');
    await withLossLimit(player);
    const refunded = await acceptedBet(app, player, { stake: '10', promotion: noRisk });
    expectApplied(await settle(refunded.args.providerBetId, 'lost', '10'));
    await adminCall(
      player.client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '10',
        currency: 'USD',
      }),
    );
    expectApplied(await reopen(refunded.args.providerBetId));
    const promo = await acceptedBet(app, player, { stake: '5', promotion: freebet });

    expectApplied(await settle(promo.args.providerBetId, 'won', '10'));

    expect(await lossLimitUsed(player)).toBe(money('10'));
    const [debt] = await drizzle()
      .select()
      .from(sportsbookPlayerDebt)
      .where(eq(sportsbookPlayerDebt.userId, player.userId));
    expect(debt).toMatchObject({ outstanding: money('0'), status: 'cleared' });
    expect(
      await drizzle()
        .select({ type: walletTransaction.type, round: walletTransaction.externalRoundId })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(
          and(
            eq(wallet.userId, player.userId),
            eq(walletTransaction.type, 'win_reversal'),
            gt(walletTransaction.amount, '0'),
          ),
        ),
    ).toEqual([{ type: 'win_reversal', round: refunded.args.providerBetId }]);
  });
});

describe('wager tracking', () => {
  beforeAll(async () => {
    await adminCall(
      admin.put('/backoffice/promo/streaks/config', {
        currency: 'USD',
        dailyMinWager: '1000',
        eligibleProducts: [],
        milestones: [],
        resetAfterDay: 30,
      }),
    );
  });

  const wageredToday = async (userId: string) =>
    (
      await drizzle()
        .select({ wagered: promoStreakDailyWager.wagered })
        .from(promoStreakDailyWager)
        .where(eq(promoStreakDailyWager.userId, userId))
    ).map((r) => r.wagered);

  const rankOf = async (userId: string) =>
    (
      await drizzle()
        .select({ lifetimeWagered: promoPlayerRank.lifetimeWagered })
        .from(promoPlayerRank)
        .where(eq(promoPlayerRank.userId, userId))
    ).map((r) => r.lifetimeWagered);

  it('records no progress for a promotion-paid stake', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'won', '12.50'));
    expect(await wageredToday(player.userId)).toEqual([]);
    expect(await rankOf(player.userId)).toEqual([]);

    const control = await fundedPlayer(app, '100');
    await acceptedBet(app, control, { stake: '5' });
    expect(await wageredToday(control.userId)).toEqual([money('5')]);
  });

  it('keeps the progress of a refunded loss', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, { stake: '10', promotion: noRisk });
    expect(await wageredToday(player.userId)).toEqual([money('10')]);
    expectApplied(await settle(args.providerBetId, 'lost', '10'));
    expect(await wageredToday(player.userId)).toEqual([money('10')]);
  });
});

describe('promotion report', () => {
  it('refuses a player', async () => {
    const player = await fundedPlayer(app, '100');
    const res = await player.client.get('/backoffice/sportsbook/promotions/report');
    expect(res.status).toBe(403);
  });

  it('reports a type label that names an object property under the default funder', async () => {
    const from = new Date().toISOString();
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, {
      stake: '5',
      promotion: { type: 'constructor', stake: 'promotion', voidReturnsStake: false },
    });
    expectApplied(await settle(args.providerBetId, 'won', '7'));
    const res = await admin.get(
      `/backoffice/sportsbook/promotions/report?dateFrom=${encodeURIComponent(from)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.arrayContaining([
        {
          type: 'constructor',
          funder: 'operator',
          currency: 'USD',
          bets: 1,
          promotionPaid: money('7'),
          promotionReversed: money('0'),
        },
      ]),
    );
  });

  it('sums what promotions paid by type, funder and currency', async () => {
    const from = new Date().toISOString();
    const player = await fundedPlayer(app, '100');
    const a = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(a.args.providerBetId, 'won', '12.50'));
    const b = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(b.args.providerBetId, 'half_lost', '2.50'));
    const c = await acceptedBet(app, player, { stake: '5', promotion: noRisk });
    expectApplied(await settle(c.args.providerBetId, 'lost', '5'));
    const reopened = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(reopened.args.providerBetId, 'won', '10'));
    expectApplied(await reopen(reopened.args.providerBetId));

    const res = await admin.get(
      `/backoffice/sportsbook/promotions/report?dateFrom=${encodeURIComponent(from)}`,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      type: string;
      funder: string;
      currency: string;
      bets: number;
      promotionPaid: string;
      promotionReversed: string;
    }[];
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          type: 'freebet',
          funder: 'provider',
          currency: 'USD',
          bets: 3,
          promotionPaid: money('25'),
          promotionReversed: money('10'),
        },
        {
          type: 'no-risk',
          funder: 'operator',
          currency: 'USD',
          bets: 1,
          promotionPaid: money('5'),
          promotionReversed: money('0'),
        },
      ]),
    );
  });

  it('keeps the funder a bet was placed under when the funder map changes', async () => {
    const from = new Date().toISOString();
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '5', promotion: freebet });
    expectApplied(await settle(args.providerBetId, 'won', '12.50'));
    await enableSportsbook(app, { promotions: { ...PROMOTIONS, funder: {} } }, admin);
    try {
      const res = await admin.get(
        `/backoffice/sportsbook/promotions/report?dateFrom=${encodeURIComponent(from)}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        expect.objectContaining({ type: 'freebet', funder: 'provider', bets: 1 }),
      ]);
      expect((await betRow(betId)).promotionFunder).toBe('provider');
    } finally {
      await enableSportsbook(app, { promotions: PROMOTIONS }, admin);
    }
  });

  it('keeps a closed period as it was when a later reopen takes the payout back', async () => {
    const from = new Date().toISOString();
    const player = await fundedPlayer(app, '100');
    const promotion: Promotion = {
      type: 'period-check',
      stake: 'promotion',
      voidReturnsStake: false,
    };
    const { args } = await acceptedBet(app, player, { stake: '5', promotion });
    expectApplied(await settle(args.providerBetId, 'won', '10'));
    const closedAt = new Date().toISOString();
    expectApplied(await reopen(args.providerBetId));

    const report = async (range: string) => {
      const res = await admin.get(`/backoffice/sportsbook/promotions/report?${range}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { type: string }[]).filter((r) => r.type === 'period-check');
    };
    const at = (iso: string) => encodeURIComponent(iso);
    expect(await report(`dateFrom=${at(from)}&dateTo=${at(closedAt)}`)).toEqual([
      expect.objectContaining({
        bets: 1,
        promotionPaid: money('10'),
        promotionReversed: money('0'),
      }),
    ]);
    expect(await report(`dateFrom=${at(closedAt)}`)).toEqual([
      expect.objectContaining({
        bets: 0,
        promotionPaid: money('0'),
        promotionReversed: money('10'),
      }),
    ]);
  });
});
