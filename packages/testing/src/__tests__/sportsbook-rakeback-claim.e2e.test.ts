import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { promoRakebackAccrual } from '@openora/core/promo/schema/gamification';
import { walletTransaction } from '@openora/core/wallet/schema';
import { closeE2e, readJson, type TestApp, type TestClient, type TestDb } from '../index.js';
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
  ({ db, app } = await bootSportsbookApp({
    fixtures: [
      {
        id: 'testing-rakeback-stake-claim-config',
        file: 'test-rakeback-stake-claim-config-plugin.ts',
      },
    ],
  }));
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

const accrualsOf = (userId: string) =>
  drizzle()
    .select({
      status: promoRakebackAccrual.status,
      amount: promoRakebackAccrual.amount,
      currency: promoRakebackAccrual.currency,
      providerName: promoRakebackAccrual.providerName,
      externalRoundId: promoRakebackAccrual.externalRoundId,
    })
    .from(promoRakebackAccrual)
    .where(eq(promoRakebackAccrual.userId, userId))
    .orderBy(asc(promoRakebackAccrual.createdAt), asc(promoRakebackAccrual.id));

const accrued = (providerBetId: string, status = 'accrued') => ({
  status,
  amount: '0.100000000000000000',
  currency: 'USD',
  providerName: `sportsbook:${PROVIDER}`,
  externalRoundId: providerBetId,
});

const reservedBet = async (player: SportsbookPlayer) => {
  const args = reserveArgs(player.sessionId, { stake: '10', potentialPayout: '25' });
  expectApplied(await ledgerOf(app).reserve(args));
  return args;
};

const cancel = (providerBetId: string, reason: 'rejected' | 'discarded', providerTxId = txId()) =>
  ledgerOf(app)
    .cancel({ provider: PROVIDER, providerTxId, providerBetId, reason })
    .then(expectApplied);

describe('sportsbook rakeback accrued for a claim', () => {
  it('accrues nothing for a bet the provider rejects, however often it repeats the reject', async () => {
    const player = await fundedPlayer(app);
    const args = await reservedBet(player);
    const rejectTx = txId();

    await cancel(args.providerBetId, 'rejected', rejectTx);
    await cancel(args.providerBetId, 'rejected', rejectTx);

    expect(await accrualsOf(player.userId)).toEqual([]);
  });

  it('accrues nothing for a cancelled bet', async () => {
    const player = await fundedPlayer(app);
    const args = await reservedBet(player);

    await cancel(args.providerBetId, 'discarded');

    expect(await accrualsOf(player.userId)).toEqual([]);
  });

  it('accrues nothing while the bet is open or once it is voided', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expect(await accrualsOf(player.userId)).toEqual([]);

    await settle(args.providerBetId, 'void', '10');

    expect(await accrualsOf(player.userId)).toEqual([]);
  });

  it('accrues on a settled loss and moves no money', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });

    await settle(args.providerBetId, 'lost', '0');

    expect(await accrualsOf(player.userId)).toEqual([accrued(args.providerBetId)]);
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });

  it('accrues on a settled win', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });

    await settle(args.providerBetId, 'won', '25');

    expect(await accrualsOf(player.userId)).toEqual([accrued(args.providerBetId)]);
  });

  it('takes the accrual back on a reopen and accrues once when the bet settles again', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'lost', '0');

    await reopen(args.providerBetId);
    expect(await accrualsOf(player.userId)).toEqual([accrued(args.providerBetId, 'reversed')]);

    await settle(args.providerBetId, 'won', '25');
    expect(await accrualsOf(player.userId)).toEqual([
      accrued(args.providerBetId, 'reversed'),
      accrued(args.providerBetId),
    ]);
  });

  it('keeps nothing accrued when a reopened bet is voided', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'won', '25');

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'void', '10');

    expect(await accrualsOf(player.userId)).toEqual([accrued(args.providerBetId, 'reversed')]);
  });

  it('pays a claimed accrual once, however the reopened bet settles again', async () => {
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'won', '25');
    const claimed = await player.client.post('/promo/rakeback/claim', {
      idempotencyKey: randomUUID(),
    });
    expect(claimed.status).toBe(200);
    const { claimId } = (await readJson(claimed)) as { claimId: string };

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'won', '25');

    expect(await accrualsOf(player.userId)).toEqual([accrued(args.providerBetId, 'claimed')]);
    expect(
      await drizzle()
        .select({ amount: walletTransaction.amount })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.type, 'cashback'),
            eq(walletTransaction.providerRefId, `${claimId}:USD`),
          ),
        ),
    ).toEqual([{ amount: '0.100000000000000000' }]);
  });

  it('accrues nothing for a free bet that wins', async () => {
    const player = await fundedPlayer(app);
    await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    const free = await acceptedBet(app, player, {
      stake: '5',
      potentialPayout: '12.50',
      promotion: { type: 'freebet', id: 'grant-1', stake: 'promotion', voidReturnsStake: false },
    });

    await settle(free.args.providerBetId, 'won', '12.50');

    expect(await accrualsOf(player.userId)).toEqual([]);
  });

  it('still accrues a casino stake when it is wagered', async () => {
    const player = await fundedPlayer(app);
    const roundId = randomUUID();

    await drizzle().transaction((tx) =>
      app.container.get(WAGER_TRACKING).recordWager(tx, {
        userId: player.userId,
        currency: 'USD',
        amount: '50',
        weightedAmount: '50',
        realAmount: '50',
        context: { provider: 'aggregator', product: 'casino' },
        round: { providerName: 'aggregator', externalRoundId: roundId },
      }),
    );

    expect(await accrualsOf(player.userId)).toEqual([
      {
        status: 'accrued',
        amount: '0.500000000000000000',
        currency: 'USD',
        providerName: 'aggregator',
        externalRoundId: roundId,
      },
    ]);
  });
});
