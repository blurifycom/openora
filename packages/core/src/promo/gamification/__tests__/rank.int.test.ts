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

const CASINO = { provider: 'aggregator', product: 'casino' };
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
  config: { eligibleProducts: [], rewards: {}, payoutAnchors: DEFAULT_PAYOUT_ANCHORS },
};
const PARALLEL_BETS = 20;

const wager = (userId: string, amount: string, currency = 'USDT', context: WagerContext = CASINO) =>
  db.drizzle.db.transaction((tx) =>
    ranks.recordWager(tx, { userId, currency, amount, weightedAmount: amount, context }),
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
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await seedRankLadder(db.drizzle.db, LADDER);
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

    expect(convert).toHaveBeenCalledWith('10', 'BTC', 'USDT');
    expect((await rankOf(userId))?.lifetimeWagered).toBe('11.000000000000000000');
  });

  it('skips the wager without throwing when no rate is available', async () => {
    const userId = randomUUID();
    convert.mockResolvedValue(null);

    await expect(wager(userId, '10', 'BTC')).resolves.toBeUndefined();

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
      bonusAmount: '40',
      context: CASINO,
    };

    await db.drizzle.db.transaction((tx) => ranks.recordWager(tx, partlyBonusFunded));

    expect((await rankOf(userId))?.lifetimeWagered).toBe('100.000000000000000000');
  });
});
