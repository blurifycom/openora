import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoPlayerRank, promoRankTier } from '../schema/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RankService } from '../service/rank.service.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn() };
let ranks: RankService;

const CASINO = { provider: 'aggregator', product: 'casino' };
const PARALLEL_BETS = 20;

const wager = (userId: string, weightedAmount: string, currency = 'USDT') =>
  db.drizzle.db.transaction((tx) =>
    ranks.recordWager(tx, {
      userId,
      currency,
      amount: weightedAmount,
      weightedAmount,
      context: CASINO,
    }),
  );

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
  ranks = new RankService(db.drizzle, mock<ExchangeRateReader>({ convert }), logger);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await seedRankLadder(db.drizzle.db);
});

describe('recording a wager toward the rank ladder', () => {
  it('accrues the exact weighted amount of a ladder-currency wager, not the stake', async () => {
    const userId = randomUUID();

    await db.drizzle.db.transaction((tx) =>
      ranks.recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '100',
        weightedAmount: '12.345678901234567891',
        context: CASINO,
      }),
    );

    expect(await rankOf(userId)).toEqual({
      lifetimeWagered: '12.345678901234567891',
      tier: 'bronze',
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it('leaves no row for a zero weighted amount', async () => {
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
      { userId, from: 'BTC', to: 'USDT' },
      expect.any(String),
    );
  });

  it('sums concurrent wagers from separate transactions exactly', async () => {
    const userId = randomUUID();

    await Promise.all(Array.from({ length: PARALLEL_BETS }, () => wager(userId, '1.5')));

    expect((await rankOf(userId))?.lifetimeWagered).toBe('30.000000000000000000');
  });

  it.skip('a bonus-funded stake accrues separately and does not count toward lifetime wagered (blocked: bonus-funded stake is not on the port yet)', () => {});
});
