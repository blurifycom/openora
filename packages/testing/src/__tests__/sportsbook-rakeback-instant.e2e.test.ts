import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { sportsbookBetTransaction } from '@openora/core/sportsbook/schema/betting';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { closeE2e, type TestApp, type TestClient, type TestDb } from '../index.js';
import { EXAMPLE_RANK_LADDER } from '../seed.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PROVIDER,
  acceptedBet,
  balanceOf,
  bootSportsbookApp,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  reserveArgs,
  txId,
  type SportsbookPlayer,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app, {
    promotions: { enabled: true, maxPromotionStakeUsd: '50', funder: { freebet: 'provider' } },
  });
  const ranks = await admin.put('/backoffice/promo/ranks/config', {
    ...EXAMPLE_RANK_LADDER.config,
    rakebackEligibleProducts: ['casino', 'sportsbook'],
  });
  expect(ranks.status).toBe(200);
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const drizzle = () => app.container.get(DRIZZLE).db;

const settle = (providerBetId: string, result: 'won' | 'lost' | 'void', payout: string) =>
  ledgerOf(app)
    .settle({ provider: PROVIDER, providerTxId: txId(), providerBetId, result, payout })
    .then(expectApplied);

const reopen = (providerBetId: string) =>
  ledgerOf(app)
    .reopen({ provider: PROVIDER, providerTxId: txId(), providerBetId })
    .then(expectApplied);

const rakebackOf = (providerBetId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, currency: walletTransaction.currency })
    .from(walletTransaction)
    .where(
      and(
        eq(walletTransaction.type, 'cashback'),
        eq(walletTransaction.providerName, 'rakeback-settled'),
        eq(walletTransaction.providerRefId, `sportsbook:${PROVIDER}:${providerBetId}`),
      ),
    );

const settleRowOf = (providerBetId: string) =>
  drizzle()
    .select({
      walletTransactionIds: sportsbookBetTransaction.walletTransactionIds,
      balanceAfter: sportsbookBetTransaction.balanceAfter,
    })
    .from(sportsbookBetTransaction)
    .where(
      and(
        eq(sportsbookBetTransaction.providerBetId, providerBetId),
        eq(sportsbookBetTransaction.kind, 'settle'),
      ),
    );

const rakebackIdOf = (providerBetId: string) =>
  drizzle()
    .select({ id: walletTransaction.id })
    .from(walletTransaction)
    .where(
      and(
        eq(walletTransaction.providerName, 'rakeback-settled'),
        eq(walletTransaction.providerRefId, `sportsbook:${PROVIDER}:${providerBetId}`),
      ),
    );

const cashbackOf = (userId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, providerName: walletTransaction.providerName })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, 'cashback')));

const PAID = [{ amount: '0.100000000000000000', currency: 'USD' }];

const reservedBet = async (player: SportsbookPlayer) => {
  const args = reserveArgs(player.sessionId, { stake: '10', potentialPayout: '25' });
  expectApplied(await ledgerOf(app).reserve(args));
  return args;
};

const cancel = (providerBetId: string, reason: 'rejected' | 'discarded', providerTxId = txId()) =>
  ledgerOf(app)
    .cancel({ provider: PROVIDER, providerTxId, providerBetId, reason })
    .then(expectApplied);

describe('sportsbook rakeback paid instantly', () => {
  it('pays nothing for a bet the provider rejects, however often it repeats the reject', async () => {
    const player = await fundedPlayer(app);
    const args = await reservedBet(player);
    const rejectTx = txId();

    await cancel(args.providerBetId, 'rejected', rejectTx);
    await cancel(args.providerBetId, 'rejected', rejectTx);

    expect(await cashbackOf(player.userId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('pays nothing for a cancelled bet', async () => {
    const player = await fundedPlayer(app);
    const args = await reservedBet(player);

    await cancel(args.providerBetId, 'discarded');

    expect(await cashbackOf(player.userId)).toEqual([]);
  });

  it('pays nothing while the bet is open or once it is voided', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expect(await cashbackOf(player.userId)).toEqual([]);

    await settle(args.providerBetId, 'void', '10');

    expect(await cashbackOf(player.userId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('pays on a settled loss', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });

    const settled = await settle(args.providerBetId, 'lost', '0');

    expect(await rakebackOf(args.providerBetId)).toEqual(PAID);
    expect(settled.balance).toBe('90.100000000000000000');
  });

  it('pays on a settled win, and the settle answers with the balance it paid into', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });

    const settled = await settle(args.providerBetId, 'won', '25');

    expect(await rakebackOf(args.providerBetId)).toEqual(PAID);
    expect(settled.balance).toBe('115.100000000000000000');
    expect(await balanceOf(app, player.userId)).toBe('115.100000000000000000');
    const [rakeback] = await rakebackIdOf(args.providerBetId);
    const [row] = await settleRowOf(args.providerBetId);
    expect(row?.walletTransactionIds).toContain(rakeback?.id);
    expect(row?.walletTransactionIds).toHaveLength(2);
    expect(row?.balanceAfter).toBe('115.100000000000000000');
  });

  it('pays once when a reopened bet settles again', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'lost', '0');

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'won', '25');

    expect(await rakebackOf(args.providerBetId)).toEqual(PAID);
    expect(await balanceOf(app, player.userId)).toBe('115.100000000000000000');
  });

  it('leaves paid rakeback to a manual adjustment when a reopened bet is voided', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'lost', '0');

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'void', '10');

    expect(await rakebackOf(args.providerBetId)).toEqual(PAID);
    expect(await balanceOf(app, player.userId)).toBe('100.100000000000000000');
  });

  it('pays nothing for a free bet that wins', async () => {
    const player = await fundedPlayer(app);
    await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    const free = await acceptedBet(app, player, {
      stake: '5',
      potentialPayout: '12.50',
      promotion: { type: 'freebet', id: 'grant-1', stake: 'promotion', voidReturnsStake: false },
    });

    await settle(free.args.providerBetId, 'won', '12.50');

    expect(await cashbackOf(player.userId)).toEqual([]);
  });

  it('still pays a casino stake when it is wagered', async () => {
    const player = await fundedPlayer(app);

    await drizzle().transaction((tx) =>
      app.container.get(WAGER_TRACKING).recordWager(tx, {
        userId: player.userId,
        currency: 'USD',
        amount: '50',
        weightedAmount: '50',
        realAmount: '50',
        context: { provider: 'aggregator', product: 'casino' },
        round: { providerName: 'aggregator', externalRoundId: randomUUID() },
      }),
    );

    expect(await cashbackOf(player.userId)).toEqual([
      { amount: '0.500000000000000000', providerName: null },
    ]);
  });
});
