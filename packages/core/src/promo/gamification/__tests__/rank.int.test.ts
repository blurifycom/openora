import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, mock } from '../../../testing/mock.js';
import type { ExchangeRateReader, WagerContext } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankRoundWager,
  promoRankTier,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RankService } from '../service/rank.service.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn() };
const audit = makeAuditWriter();
let ranks: RankService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const LADDER = {
  currency: 'USDT',
  tiers: [
    { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' },
    {
      key: 'silver',
      name: 'Silver',
      wagerThreshold: '10000',
      rakebackPercent: '3',
      levelUpBonus: '10',
    },
    {
      key: 'gold',
      name: 'Gold',
      wagerThreshold: '50000',
      rakebackPercent: '5',
      levelUpBonus: '25.5',
    },
  ],
  config: {
    eligibleProducts: [],
    rewards: {},
    payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    payInPlayerCurrency: false,
    periodicRequiresActivity: true,
  },
};
const PARALLEL_BETS = 20;

const wager = (userId: string, amount: string, currency = 'USDT', context: WagerContext = CASINO) =>
  db.drizzle.db.transaction((tx) =>
    ranks.recordWager(tx, {
      userId,
      currency,
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context,
    }),
  );

const levelUpsOf = (userId: string) =>
  db.drizzle.db
    .select({ tier: promoRankTier.key, amount: promoRankLevelUp.amount })
    .from(promoRankLevelUp)
    .innerJoin(promoRankTier, eq(promoRankTier.id, promoRankLevelUp.tierId))
    .where(eq(promoRankLevelUp.userId, userId))
    .orderBy(promoRankTier.position);

const rankOf = async (userId: string) => {
  const [row] = await db.drizzle.db
    .select({ lifetimeWagered: promoPlayerRank.lifetimeWagered, tier: promoRankTier.key })
    .from(promoPlayerRank)
    .leftJoin(promoRankTier, eq(promoRankTier.id, promoPlayerRank.tierId))
    .where(eq(promoPlayerRank.userId, userId));
  return row;
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  ranks = new RankService(db.drizzle, mock<ExchangeRateReader>({ convert }), audit, logger);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.delete(promoRankRoundWager);
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoRankPeriodWager);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await seedRankLadder(db.drizzle.db, LADDER);
});

describe('seeding rank percentages', () => {
  it('refuses a seeded tier whose combined percentages exceed 100', async () => {
    await expect(
      seedRankLadder(db.drizzle.db, {
        ...LADDER,
        tiers: [
          {
            key: 'excess',
            name: 'Excess',
            wagerThreshold: '1',
            rakebackPercent: '60',
            dailyBonusPercent: '50',
          },
        ],
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    expect(
      await db.drizzle.db.select().from(promoRankTier).where(eq(promoRankTier.key, 'excess')),
    ).toEqual([]);
  });
});

describe('recording a wager toward the rank ladder', () => {
  it('accrues the exact stake of a ladder-currency wager, not the bonus-weighted amount', async () => {
    const userId = randomUUID();

    await db.drizzle.db.transaction((tx) =>
      ranks.recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '12.345678901234567891',
        weightedAmount: '0',
        realAmount: '12.345678901234567891',
        context: CASINO,
      }),
    );

    expect(await rankOf(userId)).toEqual({
      lifetimeWagered: '12.345678901234567891',
      tier: 'bronze',
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it('leaves no row for a zero stake', async () => {
    const userId = randomUUID();

    await wager(userId, '0');

    expect(await rankOf(userId)).toBeUndefined();
  });

  it('counts the exact threshold as reached and one unit below as not', async () => {
    const userId = randomUUID();

    await wager(userId, '9999.999999999999999999');
    expect((await rankOf(userId))?.tier).toBe('bronze');

    await wager(userId, '0.000000000000000001');
    expect((await rankOf(userId))?.tier).toBe('silver');
  });

  it('lands on the higher tier when one wager crosses two thresholds', async () => {
    const userId = randomUUID();
    await wager(userId, '1');

    await wager(userId, '60000');

    expect(await rankOf(userId)).toEqual({
      lifetimeWagered: '60001.000000000000000000',
      tier: 'gold',
    });
  });

  it('never lowers a rank after the threshold is raised', async () => {
    const userId = randomUUID();
    await wager(userId, '10000');
    await db.drizzle.db
      .update(promoRankTier)
      .set({ wagerThreshold: '20000' })
      .where(eq(promoRankTier.key, 'silver'));

    await wager(userId, '1');

    expect((await rankOf(userId))?.tier).toBe('silver');
  });

  it('accrues the converted amount of a wager in another currency', async () => {
    const userId = randomUUID();
    convert.mockResolvedValue('11');

    await wager(userId, '10', 'BTC');

    expect(convert).toHaveBeenCalledWith('10', 'BTC', 'USDT', expect.anything());
    expect((await rankOf(userId))?.lifetimeWagered).toBe('11.000000000000000000');
  });

  it('skips the wager without throwing when no rate is available', async () => {
    const userId = randomUUID();
    convert.mockResolvedValue(null);

    await expect(wager(userId, '10', 'BTC')).resolves.toEqual([]);

    expect(await rankOf(userId)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { userId, from: 'BTC', to: 'USDT', amount: '10' },
      expect.any(String),
    );
  });

  it('sums concurrent wagers from separate transactions exactly', async () => {
    const userId = randomUUID();

    await Promise.all(Array.from({ length: PARALLEL_BETS }, () => wager(userId, '1.5')));

    expect((await rankOf(userId))?.lifetimeWagered).toBe('30.000000000000000000');
  });

  it('records the rank a player reached, and nothing for a wager that leaves it alone', async () => {
    const userId = randomUUID();

    await wager(userId, '10000');
    const [, promotion] = audit.recordInTransaction.mock.calls.at(-1) ?? [];
    await wager(userId, '1');

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(promotion).toMatchObject({
      actorType: 'system',
      action: 'promo.rank.changed',
      resourceType: 'promo_player_rank',
      resourceId: userId,
      before: { tierId: null },
      after: { tierId: expect.any(String) },
    });
  });

  it('counts only the products the ladder is configured for', async () => {
    const userId = randomUUID();
    await db.drizzle.db.update(promoRankConfig).set({ eligibleProducts: ['casino'] });

    await wager(userId, '5', 'USDT', { provider: 'aggregator', product: 'pvp' });
    await wager(userId, '7', 'USDT', CASINO);

    expect((await rankOf(userId))?.lifetimeWagered).toBe('7.000000000000000000');
  });

  it('counts nothing while the ladder has no settings', async () => {
    const userId = randomUUID();
    await db.drizzle.db.delete(promoRankConfig);

    await wager(userId, '100');

    expect(await rankOf(userId)).toBeUndefined();
  });

  it('accumulates the stake into the day, week and month it was placed in', async () => {
    const userId = randomUUID();

    await wager(userId, '10');
    await wager(userId, '5');

    const rows = await db.drizzle.db
      .select({ kind: promoRankPeriodWager.kind, wagered: promoRankPeriodWager.wagered })
      .from(promoRankPeriodWager)
      .where(eq(promoRankPeriodWager.userId, userId))
      .orderBy(promoRankPeriodWager.kind);

    expect(rows).toEqual([
      { kind: 'daily', wagered: '15.000000000000000000' },
      { kind: 'monthly', wagered: '15.000000000000000000' },
      { kind: 'weekly', wagered: '15.000000000000000000' },
    ]);
  });

  it('stamps the time of the last counted wager', async () => {
    const userId = randomUUID();

    await wager(userId, '1');

    const [row] = await db.drizzle.db
      .select({ lastWageredAt: promoPlayerRank.lastWageredAt })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, userId));
    expect(row?.lastWageredAt).toBeInstanceOf(Date);
  });

  it('owes a level-up bonus for every tier one wager crosses, at the amount each paid then', async () => {
    const userId = randomUUID();

    await wager(userId, '60000');
    await db.drizzle.db
      .update(promoRankTier)
      .set({ levelUpBonus: '999' })
      .where(eq(promoRankTier.key, 'gold'));

    expect(await levelUpsOf(userId)).toEqual([
      { tier: 'silver', amount: '10.000000000000000000' },
      { tier: 'gold', amount: '25.500000000000000000' },
    ]);
  });

  it('owes nothing for a tier reached while it had no level-up amount, even once one is set', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .update(promoRankTier)
      .set({ levelUpBonus: null })
      .where(eq(promoRankTier.key, 'silver'));

    await wager(userId, '10000');
    await db.drizzle.db
      .update(promoRankTier)
      .set({ levelUpBonus: '10' })
      .where(eq(promoRankTier.key, 'silver'));
    await wager(userId, '1');

    expect(await levelUpsOf(userId)).toEqual([]);
  });

  it.skip('counts a bonus-funded stake in full toward lifetime wagered, tracking its bonus part on its own counter (blocked: WagerTrackingArgs carries no bonusAmount)', async () => {
    const userId = randomUUID();
    const partlyBonusFunded = {
      userId,
      currency: 'USDT',
      amount: '100',
      weightedAmount: '100',
      realAmount: '100',
      bonusAmount: '40',
      context: CASINO,
    };

    await db.drizzle.db.transaction((tx) => ranks.recordWager(tx, partlyBonusFunded));

    expect((await rankOf(userId))?.lifetimeWagered).toBe('100.000000000000000000');
  });
});

describe('counting the house edge toward the periodic bonus', () => {
  const SLOT = { ...CASINO, rtp: '0.96' };

  const counters = (userId: string) =>
    db.drizzle.db
      .select({
        kind: promoRankPeriodWager.kind,
        wagered: promoRankPeriodWager.wagered,
        margin: promoRankPeriodWager.margin,
      })
      .from(promoRankPeriodWager)
      .where(eq(promoRankPeriodWager.userId, userId))
      .orderBy(promoRankPeriodWager.kind);

  const marginOf = async (userId: string) => {
    const rows = await counters(userId);
    expect(new Set(rows.map((row) => row.margin)).size).toBe(1);
    return rows[0]?.margin;
  };

  const bet = (userId: string, args: { amount: string; realAmount?: string; currency?: string }) =>
    db.drizzle.db.transaction((tx) =>
      ranks.recordWager(tx, {
        userId,
        currency: args.currency ?? 'USDT',
        amount: args.amount,
        weightedAmount: args.amount,
        realAmount: args.realAmount ?? args.amount,
        context: SLOT,
        round: { providerName: 'aggregator', externalRoundId: userId },
      }),
    );

  const rollback = (userId: string, realAmount: string) =>
    db.drizzle.db.transaction((tx) =>
      ranks.reverseWager(tx, {
        userId,
        currency: 'USDT',
        round: { providerName: 'aggregator', externalRoundId: userId },
        realAmount,
      }),
    );

  it('sums own-money stake × (1 − rtp) into every open period', async () => {
    const userId = randomUUID();

    await bet(userId, { amount: '100' });
    await bet(userId, { amount: '50' });

    expect(await counters(userId)).toEqual(
      ['daily', 'monthly', 'weekly'].map((kind) => ({
        kind,
        wagered: '150.000000000000000000',
        margin: '6.000000000000000000',
      })),
    );
  });

  it('adds nothing for a bet with no rtp, or one outside zero to one', async () => {
    const userId = randomUUID();

    await wager(userId, '100');
    await wager(userId, '100', 'USDT', { ...CASINO, rtp: '96' });

    expect(await marginOf(userId)).toBe('0.000000000000000000');
    expect((await rankOf(userId))?.lifetimeWagered).toBe('200.000000000000000000');
  });

  it('adds nothing for the bonus-funded part of a stake', async () => {
    const userId = randomUUID();

    await bet(userId, { amount: '100', realAmount: '25' });
    await bet(userId, { amount: '100', realAmount: '0' });

    expect(await marginOf(userId)).toBe('1.000000000000000000');
  });

  it('converts the margin at the rate the stake converted at', async () => {
    const userId = randomUUID();
    convert.mockResolvedValue('200');

    await bet(userId, { amount: '0.002', currency: 'BTC' });

    expect(await marginOf(userId)).toBe('8.000000000000000000');
  });

  it('skips conversion for excluded products while preserving mixed-round reversal proportions', async () => {
    const userId = randomUUID();
    await db.drizzle.db.update(promoRankConfig).set({ eligibleProducts: ['casino'] });
    await bet(userId, { amount: '100' });
    await db.drizzle.db.transaction((tx) =>
      ranks.recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '100',
        weightedAmount: '100',
        realAmount: '100',
        context: { ...SLOT, product: 'pvp' },
        round: { providerName: 'aggregator', externalRoundId: userId },
      }),
    );
    await db.drizzle.db.transaction((tx) =>
      ranks.recordWager(tx, {
        userId: randomUUID(),
        currency: 'BTC',
        amount: '1',
        weightedAmount: '1',
        realAmount: '1',
        context: { ...SLOT, product: 'pvp' },
        round: { providerName: 'aggregator', externalRoundId: randomUUID() },
      }),
    );
    expect(convert).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    await rollback(userId, '100');
    expect(await marginOf(userId)).toBe('2.000000000000000000');
  });

  it('takes a rolled-back stake back out of the margin, and leaves the wagered counters', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '100' });

    await rollback(userId, '25');

    expect(await marginOf(userId)).toBe('3.000000000000000000');
    expect((await counters(userId)).map((row) => row.wagered)).toEqual(
      Array(3).fill('100.000000000000000000'),
    );
    expect((await rankOf(userId))?.lifetimeWagered).toBe('100.000000000000000000');
  });

  it('never takes the margin below zero', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '10' });

    await rollback(userId, '1000');

    expect(await marginOf(userId)).toBe('0.000000000000000000');
  });

  it('preserves small converted margins without intermediate truncation', async () => {
    const userId = randomUUID();
    convert.mockResolvedValue('0.0000000003');
    await bet(userId, { amount: '0.00000001', currency: 'ETH' });
    expect(await marginOf(userId)).toBe('0.000000000012000000');
  });

  it('reverses every contribution in a round with different RTP values', async () => {
    const userId = randomUUID();
    for (const rtp of ['0.90', '0.99']) {
      await db.drizzle.db.transaction((tx) =>
        ranks.recordWager(tx, {
          userId,
          currency: 'USDT',
          amount: '100',
          realAmount: '100',
          weightedAmount: '100',
          context: { ...CASINO, rtp },
          round: { providerName: 'aggregator', externalRoundId: userId },
        }),
      );
    }
    expect(await marginOf(userId)).toBe('11.000000000000000000');
    await rollback(userId, '200');
    expect(await marginOf(userId)).toBe('0.000000000000000000');
  });

  it('bounds repeated and concurrent reversals by the round contribution', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '100' });
    await wager(userId, '100', 'USDT', SLOT);
    await Promise.all([rollback(userId, '100'), rollback(userId, '100')]);
    expect(await marginOf(userId)).toBe('4.000000000000000000');
    expect(
      await db.drizzle.db
        .select()
        .from(promoRankRoundWager)
        .where(eq(promoRankRoundWager.userId, userId)),
    ).toEqual([]);
  });

  it('retains tiny partial reversals and caps their total at the recorded margin', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '0.00000001' });
    await rollback(userId, '0.000000005');
    expect(await marginOf(userId)).toBe('0.000000000200000000');
    await rollback(userId, '0.000000005');
    expect(await marginOf(userId)).toBe('0.000000000000000000');
  });

  it('ignores an unknown round and another provider with the same round id', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '100' });
    await db.drizzle.db.transaction((tx) =>
      ranks.reverseWager(tx, {
        userId,
        currency: 'USDT',
        realAmount: '100',
        round: { providerName: 'other', externalRoundId: userId },
      }),
    );
    expect(await marginOf(userId)).toBe('4.000000000000000000');
  });

  it('reverses the recorded margin after the product stops being eligible', async () => {
    const userId = randomUUID();
    await bet(userId, { amount: '100' });
    await db.drizzle.db.update(promoRankConfig).set({ eligibleProducts: ['pvp'] });
    await rollback(userId, '50');
    expect(await marginOf(userId)).toBe('2.000000000000000000');
  });
});

describe('public rank lookup', () => {
  it('returns the tier key and name for each ranked user, null for one with no rank', async () => {
    const ranked = randomUUID();
    const unranked = randomUUID();
    await wager(ranked, '1');

    const result = await ranks.lookup([ranked, unranked]);

    expect(result).toEqual([
      { userId: ranked, tierKey: 'bronze', tierName: 'Bronze' },
      { userId: unranked, tierKey: null, tierName: null },
    ]);
  });

  it('returns an empty array for an empty input, without querying', async () => {
    expect(await ranks.lookup([])).toEqual([]);
  });
});
