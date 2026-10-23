import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE } from '@openora/core/server';
import type { SportsbookReserveArgs } from '@openora/core/contracts';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import {
  asPlayer,
  closeE2e,
  registerPlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
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

type ProductRevenue = {
  product: string;
  currency: string;
  stakes: string;
  payouts: string;
  ggr: string;
};

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app, {
    promotions: { enabled: true, maxPromotionStakeUsd: '50', funder: { freebet: 'provider' } },
  });
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const raceInput = (eligibleProducts: unknown, startAt = hoursFromNow(-1)) => ({
  name: `Race ${randomUUID()}`,
  currency: 'USD',
  startAt,
  endAt: hoursFromNow(24),
  prizePool: '100',
  positions: [{ position: 1, prize: '100' }],
  eligibleProducts,
});

async function createRace(eligibleProducts: string[], startAt?: string) {
  const res = await admin.post('/backoffice/promo/races', raceInput(eligibleProducts, startAt));
  if (res.status !== 200) {
    throw new Error(`race create failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

async function standing(player: SportsbookPlayer, raceId: string) {
  const res = await player.client.get(`/promo/races/${raceId}`);
  expect(res.status).toBe(200);
  return Number(((await res.json()) as { own: { wagered: string } }).own.wagered);
}

const settle = (providerBetId: string, result: 'won' | 'lost' | 'void', payout: string) =>
  ledgerOf(app)
    .settle({ provider: PROVIDER, providerTxId: txId(), providerBetId, result, payout })
    .then(expectApplied);

const reopen = (providerBetId: string) =>
  ledgerOf(app)
    .reopen({ provider: PROVIDER, providerTxId: txId(), providerBetId })
    .then(expectApplied);

describe('a race counting sportsbook bets', () => {
  it('counts a cash stake once, when the bet settles, through reopens and a void', async () => {
    const raceId = await createRace(['sportsbook']);
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    expect(await standing(player, raceId)).toBe(0);

    await settle(args.providerBetId, 'won', '25');
    expect(await standing(player, raceId)).toBe(10);

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'lost', '0');
    expect(await standing(player, raceId)).toBe(10);

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'void', '10');
    expect(await standing(player, raceId)).toBe(0);

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'won', '25');
    expect(await standing(player, raceId)).toBe(10);
  });

  it('keeps a re-settled stake in the races open when the bet first settled', async () => {
    const open = await createRace(['sportsbook']);
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'won', '25');
    const later = await createRace(['sportsbook'], new Date().toISOString());

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'void', '10');
    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'won', '25');

    expect(await standing(player, open)).toBe(10);
    expect(await standing(player, later)).toBe(0);
  });

  it('counts from the first settle that is not a void', async () => {
    const open = await createRace(['sportsbook']);
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'void', '10');
    const later = await createRace(['sportsbook'], new Date().toISOString());

    await reopen(args.providerBetId);
    await settle(args.providerBetId, 'won', '25');

    expect(await standing(player, open)).toBe(10);
    expect(await standing(player, later)).toBe(10);
  });

  it('never counts a stake a freebet paid for', async () => {
    const raceId = await createRace(['sportsbook']);
    const player = await fundedPlayer(app);
    const freebet: NonNullable<SportsbookReserveArgs['promotion']> = {
      type: 'freebet',
      id: `grant-${randomUUID()}`,
      stake: 'promotion',
      voidReturnsStake: false,
    };
    const { args } = await acceptedBet(app, player, { stake: '5', promotion: freebet });

    await settle(args.providerBetId, 'won', '12');

    expect(await standing(player, raceId)).toBe(0);
  });

  it('leaves a race that does not name sportsbook alone', async () => {
    const raceId = await createRace(['casino', 'pvp']);
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player);

    await settle(args.providerBetId, 'lost', '0');

    expect(await standing(player, raceId)).toBe(0);
  });
});

describe('race eligible products', () => {
  it('stores the products a race names', async () => {
    const res = await admin.post('/backoffice/promo/races', raceInput(['casino', 'sportsbook']));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { eligibleProducts: string[] }).eligibleProducts).toEqual([
      'casino',
      'sportsbook',
    ]);
  });

  it.each([
    ['an empty list', [], ['eligibleProducts'], 'select at least one product'],
    ['a repeated product', ['casino', 'casino'], ['eligibleProducts'], 'products must not repeat'],
    ['an unknown product', ['slots'], ['eligibleProducts', 0], expect.any(String)],
  ])('refuses %s on create', async (_, products, path, message) => {
    const res = await admin.post('/backoffice/promo/races', raceInput(products));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: { issues: [expect.objectContaining({ path, message })] },
    });
  });

  it('refuses an empty list on update', async () => {
    const raceId = await createRace(['casino']);

    const res = await admin.put(`/backoffice/promo/races/${raceId}`, raceInput([]));

    expect(res.status).toBe(400);
  });
});

describe('revenue by product', () => {
  const products = async (from: Date, to: Date) => {
    const query = new URLSearchParams({
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      currency: 'USD',
    });
    const res = await admin.get(`/analytics/financial/products?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ProductRevenue[];
  };

  const row = (rows: ProductRevenue[], product: string) => {
    const found = rows.find((r) => r.product === product);
    return found
      ? { stakes: Number(found.stakes), payouts: Number(found.payouts), ggr: Number(found.ggr) }
      : null;
  };

  async function window<T>(step: () => Promise<T>) {
    const from = new Date();
    await step();
    return { from, to: new Date() };
  }

  it('counts the stake when accepted, the payout when settled, and takes a reopened payout back then', async () => {
    const player = await fundedPlayer(app);
    let providerBetId = '';
    const accepted = await window(async () => {
      ({
        args: { providerBetId },
      } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' }));
    });
    const settled = await window(() => settle(providerBetId, 'won', '25'));
    const resettled = await window(async () => {
      await reopen(providerBetId);
      await settle(providerBetId, 'lost', '0');
    });

    expect(row(await products(accepted.from, accepted.to), 'sportsbook')).toEqual({
      stakes: 10,
      payouts: 0,
      ggr: 10,
    });
    expect(row(await products(settled.from, settled.to), 'sportsbook')).toEqual({
      stakes: 0,
      payouts: 25,
      ggr: -25,
    });
    expect(row(await products(resettled.from, resettled.to), 'sportsbook')).toEqual({
      stakes: 0,
      payouts: -25,
      ggr: 25,
    });
    expect(row(await products(accepted.from, resettled.to), 'sportsbook')).toEqual({
      stakes: 10,
      payouts: 0,
      ggr: 10,
    });
  });

  it('takes back the whole reopened payout and leaves what it could not collect to the debts', async () => {
    const player = await fundedPlayer(app, '10');
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    await settle(args.providerBetId, 'won', '25');
    const withdrawal = await player.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '20',
      currency: 'USD',
    });
    expect(withdrawal.status).toBe(200);

    const reopened = await window(() => reopen(args.providerBetId));

    expect(row(await products(reopened.from, reopened.to), 'sportsbook')).toEqual({
      stakes: 0,
      payouts: -25,
      ggr: 25,
    });
    expect(Number(await balanceOf(app, player.userId))).toBe(0);
    const debts = await admin.get(`/backoffice/sportsbook/debts?userId=${player.userId}`);
    expect(debts.status).toBe(200);
    const { items } = (await debts.json()) as { items: { outstanding: string }[] };
    expect(items.map((d) => Number(d.outstanding))).toEqual([20]);
  });

  it('nets a voided stake to nothing', async () => {
    const player = await fundedPlayer(app);
    const played = await window(async () => {
      const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
      await settle(args.providerBetId, 'void', '10');
    });

    expect(row(await products(played.from, played.to), 'sportsbook')).toEqual({
      stakes: 10,
      payouts: 10,
      ggr: 0,
    });
  });

  it('leaves out a cancelled reserve and keeps an accepted bet the provider tries to cancel', async () => {
    const player = await fundedPlayer(app);
    const cancel = (providerBetId: string) =>
      ledgerOf(app).cancel({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId,
        reason: 'rejected',
      });
    const played = await window(async () => {
      const reserved = reserveArgs(player.sessionId, { stake: '7' });
      expectApplied(await ledgerOf(app).reserve(reserved));
      expectApplied(await cancel(reserved.providerBetId));
      const { args } = await acceptedBet(app, player, { stake: '10' });
      expect(await cancel(args.providerBetId)).toEqual({
        status: 'refused',
        reason: 'illegal_transition',
      });
    });

    expect(row(await products(played.from, played.to), 'sportsbook')).toEqual({
      stakes: 10,
      payouts: 0,
      ggr: 10,
    });
  });

  it('reports game rounds under their game type, and sportsbook from the book alone', async () => {
    const drizzle = app.container.get(DRIZZLE).db;
    const userId = await registerPlayer(app, { email: `products-${randomUUID()}@example.com` });
    const [provider] = await drizzle
      .insert(gameProvider)
      .values({ slug: `products-${randomUUID()}`, name: 'Products Provider', isActive: true })
      .returning();
    const [casinoGame, houseGame, bookGame] = await drizzle
      .insert(game)
      .values(
        (['casino', 'original', 'sportsbook'] as const).map((gameType) => ({
          name: `Products ${gameType}`,
          slug: `products-${gameType}-${randomUUID()}`,
          providerId: provider!.id,
          aggregator: 'direct',
          gameType,
        })),
      )
      .returning();
    const played = await window(() =>
      drizzle.insert(gameRound).values([
        {
          gameId: casinoGame!.id,
          userId,
          status: 'completed',
          betAmount: '20',
          winAmount: '5',
          currency: 'USD',
        },
        {
          gameId: houseGame!.id,
          userId,
          status: 'completed',
          betAmount: '8',
          winAmount: '10',
          currency: 'USD',
        },
        {
          gameId: bookGame!.id,
          userId,
          status: 'completed',
          betAmount: '30',
          winAmount: '0',
          currency: 'USD',
        },
        { gameId: casinoGame!.id, userId, status: 'active', betAmount: '50', currency: 'USD' },
      ]),
    );

    const rows = await products(played.from, played.to);

    expect(row(rows, 'casino')).toEqual({ stakes: 20, payouts: 5, ggr: 15 });
    expect(row(rows, 'original')).toEqual({ stakes: 8, payouts: 10, ggr: -2 });
    expect(row(rows, 'sportsbook')).toBeNull();
  });

  it('refuses a caller who is not an admin', async () => {
    const email = `products-player-${randomUUID()}@example.com`;
    await registerPlayer(app, { email });
    const player = await asPlayer(app.app, { email });

    const res = await player.get('/analytics/financial/products');

    expect(res.status).toBe(403);
  });
});
