import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CacheAdapter, GameType } from '@openora/core/contracts';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateBetting } from '@openora/core/sportsbook/migrate/betting';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookSession,
} from '@openora/core/sportsbook/schema/betting';
import { mock } from '../../testing/mock.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';

let db: TestDb;
let service: FinancialAnalyticsService;

const uncached = () =>
  mock<CacheAdapter>({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  });

async function seedRound(gameType: GameType, betAmount: string, winAmount: string) {
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio' })
      .returning(),
    new Error('seed: no provider'),
  );
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name: gameType,
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'agg',
        gameType,
      })
      .returning(),
    new Error('seed: no game'),
  );
  await db.drizzle.db.insert(gameRound).values({
    gameId: row.id,
    userId: randomUUID(),
    currency: 'USD',
    betAmount,
    winAmount,
    status: 'completed',
  });
}

async function seedSettledBet() {
  const userId = randomUUID();
  const session = findOneOrThrow(
    await db.drizzle.db
      .insert(sportsbookSession)
      .values({
        userId,
        provider: 'book',
        currency: 'USD',
        countryCode: 'MT',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning(),
    new Error('seed: no session'),
  );
  const bet = findOneOrThrow(
    await db.drizzle.db
      .insert(sportsbookBet)
      .values({
        userId,
        provider: 'book',
        providerBetId: randomUUID(),
        sessionId: session.id,
        currency: 'USD',
        currencyDecimals: 2,
        status: 'settled',
        result: 'won',
        stake: '10',
        cashStake: '10',
        voidPayout: '10',
        potentialPayout: '25',
        payoutTotal: '25',
        version: 2,
        legs: [],
        lastLegStartsAt: new Date(),
        acceptedAt: new Date(),
        settledAt: new Date(),
      })
      .returning(),
    new Error('seed: no bet'),
  );
  await db.drizzle.db.insert(sportsbookBetTransaction).values({
    provider: 'book',
    providerTxId: randomUUID(),
    providerBetId: bet.providerBetId,
    betId: bet.id,
    userId,
    kind: 'settle',
    amount: '25',
    betVersion: 2,
    fingerprint: 'settle',
  });
}

const products = () =>
  service.products({}).then((rows) =>
    rows.map(({ product, stakes, payouts }) => ({
      product,
      stakes: Number(stakes),
      payouts: Number(payouts),
    })),
  );

beforeAll(async () => {
  db = await createTestDb([migrateWallet, migrateGaming]);
  await seedRound('casino', '5', '2');
  await seedRound('sportsbook', '4', '1');
  service = new FinancialAnalyticsService(db.drizzle, uncached());
});

afterAll(() => db.drop());

describe('revenue by product read from the database, with no sportsbook plugin loaded', () => {
  it('counts a catalog game typed sportsbook and never reads the sportsbook tables when they are absent', async () => {
    await expect(products()).resolves.toEqual([
      { product: 'casino', stakes: 5, payouts: 2 },
      { product: 'sportsbook', stakes: 4, payouts: 1 },
    ]);
  });

  it('keeps counting the catalog game while the sportsbook tables hold no bet', async () => {
    await migrateBetting(db.url);

    await expect(products()).resolves.toEqual([
      { product: 'casino', stakes: 5, payouts: 2 },
      { product: 'sportsbook', stakes: 4, payouts: 1 },
    ]);
  });

  it('reports the sportsbook ledger in place of the catalog game once a bet is recorded', async () => {
    await seedSettledBet();

    await expect(products()).resolves.toEqual([
      { product: 'casino', stakes: 5, payouts: 2 },
      { product: 'sportsbook', stakes: 10, payouts: 25 },
    ]);
  });

  it('stops checking for the sportsbook ledger once it has found it', async () => {
    const execute = vi.spyOn(db.drizzle.db, 'execute');

    await products();

    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('reports no sportsbook promotion cost and never reads the sportsbook tables', async () => {
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    await expect(service.summary({})).resolves.toMatchObject({ sportsbookPromotionCost: [] });
  });
});
