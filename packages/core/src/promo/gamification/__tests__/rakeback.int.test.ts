import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  RankPeriodicBasis,
  WagerContext,
  WagerProduct,
  WalletCommands,
  WalletCreditArgs,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoRakebackAccrual,
  promoRakebackClaim,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankTier,
  promoStreakConfig,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RakebackService, type RakebackSettings } from '../service/rakeback.service.js';

let db: TestDb;
const logger = { warn: vi.fn() };
const credit = vi.fn<WalletCommands['credit']>();
let rakeback: RakebackService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const LADDER = {
  currency: 'USDT',
  tiers: [
    { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' },
    { key: 'silver', name: 'Silver', wagerThreshold: '10000', rakebackPercent: '3' },
    { key: 'gold', name: 'Gold', wagerThreshold: '50000', rakebackPercent: '5' },
  ],
  config: {
    eligibleProducts: [],
    rewards: {},
    payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    payInPlayerCurrency: false,
    periodicRequiresActivity: true,
  },
};

const wager = (
  userId: string,
  amount: string,
  realAmount: string = amount,
  context: WagerContext = CASINO,
) =>
  db.drizzle.db.transaction((tx) =>
    rakeback.recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount,
      context,
    }),
  );

const wagerOn = (userId: string, product: WagerProduct) =>
  wager(userId, '100', '100', { provider: 'aggregator', product });

const serviceWith = (settings: RakebackSettings, periodicBasis?: RankPeriodicBasis) =>
  new RakebackService(() => mock<WalletCommands>({ credit }), logger, settings, periodicBasis);

const betOn = (
  service: RakebackService,
  userId: string,
  amount: string,
  options: { rtp?: string; roundId?: string } = {},
) =>
  db.drizzle.db.transaction((tx) =>
    service.recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { ...CASINO, rtp: options.rtp, gameId: 'game-1' },
      round: options.roundId
        ? { providerName: 'aggregator', externalRoundId: options.roundId }
        : undefined,
    }),
  );

const rollBack = (service: RakebackService, userId: string, roundId: string, realAmount: string) =>
  db.drizzle.db.transaction((tx) =>
    service.reverseWager(tx, {
      userId,
      currency: 'USDT',
      round: { providerName: 'aggregator', externalRoundId: roundId },
      realAmount,
    }),
  );

const accrualsOf = (userId: string) =>
  db.drizzle.db
    .select()
    .from(promoRakebackAccrual)
    .where(eq(promoRakebackAccrual.userId, userId))
    .orderBy(promoRakebackAccrual.createdAt);

const givePlayerTier = async (userId: string, tierKey: string) => {
  const [tier] = await db.drizzle.db
    .select({ id: promoRankTier.id })
    .from(promoRankTier)
    .where(eq(promoRankTier.key, tierKey));
  await db.drizzle.db
    .insert(promoPlayerRank)
    .values({ userId, currency: 'USDT', tierId: tier?.id })
    .onConflictDoUpdate({ target: promoPlayerRank.userId, set: { tierId: tier?.id } });
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  rakeback = new RakebackService(() => mock<WalletCommands>({ credit }), logger);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  credit.mockResolvedValue({ ok: true, moved: true, transactionId: randomUUID(), newBalance: '0' });
  await db.drizzle.db.delete(promoRakebackAccrual);
  await db.drizzle.db.delete(promoRakebackClaim);
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoRankPeriodWager);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await db.drizzle.db.delete(promoPlayerStreak);
  await db.drizzle.db.delete(promoStreakConfig);
  await seedRankLadder(db.drizzle.db, LADDER);
});

describe('instant rakeback on a qualifying bet', () => {
  it('credits real balance at the tier rakeback percentage, off the own-money stake only', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    // Staked 100, but only 60 of it was the player's own money - the rest was bonus-funded.
    await wager(userId, '100', '60');

    expect(credit).toHaveBeenCalledTimes(1);
    const args = credit.mock.calls[0]?.[1] as WalletCreditArgs;
    expect(args).toMatchObject({
      userId,
      currency: 'USDT',
      amount: '0.600000000000000000',
      type: 'cashback',
    });
  });

  it('pays nothing for a bet fully funded by bonus money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await wager(userId, '100', '0');

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing for a player who has not been assigned a rank yet', async () => {
    const userId = randomUUID();

    await wager(userId, '100');

    expect(credit).not.toHaveBeenCalled();
  });

  it('reports the credit for the caller to announce once its own transaction commits', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    const transactionId = randomUUID();
    credit.mockResolvedValue({ ok: true, moved: true, transactionId, newBalance: '1' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([{ transactionId, amount: '1.000000000000000000', currency: 'USDT' }]);
  });

  it('reports nothing for a replayed credit that moved no money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    credit.mockResolvedValue({ ok: true, moved: false, newBalance: '1' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([]);
  });

  it('reports nothing when the wallet refuses the credit', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([]);
  });
});

describe('which products earn rakeback', () => {
  it('pays nothing for a sportsbook stake by default, though the rank counts every product', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await wagerOn(userId, 'sportsbook');
    await wagerOn(userId, 'live-casino');

    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('pays a sportsbook stake once the operator adds it to the rakeback list', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await db.drizzle.db
      .update(promoRankConfig)
      .set({ rakebackEligibleProducts: ['casino', 'sportsbook'] });

    await wagerOn(userId, 'sportsbook');

    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('pays nothing for a product the rakeback list admits but the rank does not count', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await db.drizzle.db.update(promoRankConfig).set({ eligibleProducts: ['live-casino'] });

    await wagerOn(userId, 'casino');

    expect(credit).not.toHaveBeenCalled();
  });

  it('counts every product the rank counts when the rakeback list is empty', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await db.drizzle.db.update(promoRankConfig).set({ rakebackEligibleProducts: [] });

    await wagerOn(userId, 'sportsbook');

    expect(credit).toHaveBeenCalledTimes(1);
  });
});

describe('rakeback on the house edge', () => {
  const margin = () => serviceWith({ basis: 'margin', payout: 'instant' });

  it('pays the tier rate on the stake times one minus the rtp', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.200000000000000000' });
  });

  it('pays a bottom-tier player 0.01 per 100 staked on a 99% game', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await betOn(margin(), userId, '100', { rtp: '0.99' });

    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.010000000000000000' });
  });

  it.each([
    ['missing', undefined],
    ['out of range', '1.2'],
    ['a percent', '96'],
    ['one', '1'],
    ['zero', '0'],
  ])('pays nothing when the rtp is %s', async (_label, rtp) => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    const credits = await betOn(margin(), userId, '100', { rtp });

    expect(credits).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
  });

  it('warns when a margin bet arrives without a usable rtp', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    await betOn(margin(), userId, '100', { rtp: '0' });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId, gameId: 'game-1', rtp: '0' }),
      'margin rakeback skipped: bet has no usable rtp',
    );
  });
});

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const STREAK_RATES = [
  { day: 3, unrankedRatePercent: '5', rankedUpliftPercent: '10' },
  { day: 7, unrankedRatePercent: '8', rankedUpliftPercent: '20' },
];

const enableStreak = (overrides: Partial<typeof promoStreakConfig.$inferInsert> = {}) =>
  db.drizzle.db.insert(promoStreakConfig).values({
    enabled: true,
    dailyMinWager: '10',
    eligibleProducts: ['casino', 'live-casino'],
    rakebackMilestones: STREAK_RATES,
    ...overrides,
  });

const givePlayerStreak = (userId: string, current: number, lastQualifyingDay: string | null) =>
  db.drizzle.db
    .insert(promoPlayerStreak)
    .values({ userId, current, best: current, lastQualifyingDay });

const lastCredit = () => credit.mock.calls.at(-1)?.[1] as WalletCreditArgs;

describe('streak rakeback for a ranked player', () => {
  const margin = () => serviceWith({ basis: 'margin', payout: 'instant' });

  beforeEach(async () => {
    await enableStreak();
  });

  it('multiplies the rank rakeback by the uplift: gold 5% with a 10% uplift on 100 at 96% rtp', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.220000000000000000');
  });

  it('keeps the highest unlocked uplift when a later row lowers it', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({
      rakebackMilestones: [
        { day: 3, unrankedRatePercent: '5', rankedUpliftPercent: '20' },
        { day: 7, unrankedRatePercent: '4', rankedUpliftPercent: '10' },
      ],
    });
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 9, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.240000000000000000');
  });

  it('pays the plain rank rakeback until the streak reaches its first rate row', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 2, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.200000000000000000');
  });

  it('uses the row with the highest day at or below the streak', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 50, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.240000000000000000');
  });

  it('applies the uplift to the stake basis too, which needs no rtp', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 7, daysAgo(0));

    await betOn(serviceWith({ basis: 'stake', payout: 'instant' }), userId, '100');

    expect(lastCredit().amount).toBe('6.000000000000000000');
  });

  it('turns 5 of rank rakeback with a 5% uplift into 5.25, not 10', async () => {
    const userId = randomUUID();
    await db.drizzle.db.delete(promoStreakConfig);
    await enableStreak({
      rakebackMilestones: [{ day: 1, unrankedRatePercent: '5', rankedUpliftPercent: '5' }],
    });
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 1, daysAgo(0));

    await betOn(serviceWith({ basis: 'stake', payout: 'instant' }), userId, '100');

    expect(lastCredit().amount).toBe('5.250000000000000000');
  });

  it('applies still while the player has not qualified yet today but did yesterday', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 3, daysAgo(1));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.220000000000000000');
  });

  it('pays no uplift on a broken streak, even before the close job has reset it', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 9, daysAgo(2));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.200000000000000000');
  });

  it('pays no uplift while the streak is disabled', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({ enabled: false });
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 9, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.200000000000000000');
  });

  it('pays no uplift on a product the streak does not count, though the rank still pays', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({ eligibleProducts: ['live-casino'] });
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 9, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.200000000000000000');
  });

  it('reads the rate from the config as it is when the bet settles', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 3, daysAgo(0));
    await betOn(margin(), userId, '100', { rtp: '0.96' });
    expect(lastCredit().amount).toBe('0.220000000000000000');

    await db.drizzle.db.update(promoStreakConfig).set({
      rakebackMilestones: [{ day: 3, unrankedRatePercent: '5', rankedUpliftPercent: '50' }],
    });
    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.300000000000000000');
    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.220000000000000000' });
  });

  it('pays the rank rakeback with no uplift for a bet with a 0% uplift row', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({
      rakebackMilestones: [{ day: 1, unrankedRatePercent: '5', rankedUpliftPercent: '0' }],
    });
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 4, daysAgo(0));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('0.200000000000000000');
  });

  describe('a 100% uplift on a tier whose bonus percents leave 2 points of the edge', () => {
    const upliftBy100 = async (userId: string) => {
      await db.drizzle.db.update(promoStreakConfig).set({
        rakebackMilestones: [{ day: 1, unrankedRatePercent: '5', rankedUpliftPercent: '100' }],
      });
      await db.drizzle.db
        .update(promoRankTier)
        .set({ dailyBonusPercent: '50', weeklyBonusPercent: '30', monthlyBonusPercent: '13' })
        .where(eq(promoRankTier.key, 'gold'));
      await givePlayerTier(userId, 'gold');
      await givePlayerStreak(userId, 1, daysAgo(0));
    };

    it('is trimmed to 40% so rakeback and the margin bonuses pay at most the whole edge', async () => {
      const userId = randomUUID();
      await upliftBy100(userId);

      await betOn(serviceWith({ basis: 'margin', payout: 'instant' }, 'margin'), userId, '100', {
        rtp: '0.96',
      });

      expect(lastCredit().amount).toBe('0.280000000000000000');
    });

    it('records the trimmed uplift on a claimable accrual', async () => {
      const userId = randomUUID();
      await upliftBy100(userId);

      await betOn(serviceWith({ basis: 'margin', payout: 'claim' }, 'margin'), userId, '100', {
        rtp: '0.96',
      });

      expect(await accrualsOf(userId)).toEqual([
        expect.objectContaining({
          amount: '0.280000000000000000',
          ratePercent: '5.00',
          streakMode: 'ranked',
          streakPercent: '40.00',
        }),
      ]);
    });

    it('is paid in full under the flat periodic basis, where the bonus percents pay nothing', async () => {
      const userId = randomUUID();
      await upliftBy100(userId);

      await betOn(serviceWith({ basis: 'margin', payout: 'instant' }, 'flat'), userId, '100', {
        rtp: '0.96',
      });

      expect(lastCredit().amount).toBe('0.400000000000000000');
    });

    it('is paid in full on the stake basis, which pays on turnover', async () => {
      const userId = randomUUID();
      await upliftBy100(userId);

      await betOn(serviceWith({ basis: 'stake', payout: 'instant' }, 'margin'), userId, '100');

      expect(lastCredit().amount).toBe('10.000000000000000000');
    });
  });
});

describe('streak rakeback for a player with no rank', () => {
  const instant = () => serviceWith({ basis: 'stake', payout: 'instant' });

  beforeEach(async () => {
    await enableStreak();
  });

  it('pays the unranked rate on the theoretical GGR: 2,500 at 96% rtp with 5% is 5', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(lastCredit()).toMatchObject({
      userId,
      amount: '5.000000000000000000',
      currency: 'USDT',
      type: 'cashback',
    });
  });

  it('pays on the house edge whatever the rakeback basis', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(serviceWith({ basis: 'margin', payout: 'instant' }), userId, '2500', {
      rtp: '0.96',
    });

    expect(lastCredit().amount).toBe('5.000000000000000000');
  });

  it('pays nothing without a usable rtp, and warns', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));

    const credits = await betOn(instant(), userId, '2500', {});

    expect(credits).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      'streak rakeback skipped: bet has no usable rtp',
    );
  });

  it('keeps the highest unlocked unranked rate when a later row lowers it', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({
      rakebackMilestones: [
        { day: 3, unrankedRatePercent: '5', rankedUpliftPercent: '20' },
        { day: 7, unrankedRatePercent: '4', rankedUpliftPercent: '10' },
      ],
    });
    const userId = randomUUID();
    await givePlayerStreak(userId, 9, daysAgo(0));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('5.000000000000000000');
  });

  it('pays nothing before the streak reaches its first rate row', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 2, daysAgo(0));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing for a player who has no streak yet', async () => {
    await betOn(instant(), randomUUID(), '2500', { rtp: '0.96' });

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing on a broken streak', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 9, daysAgo(2));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing while the streak is disabled, or was never configured', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 9, daysAgo(0));
    await db.drizzle.db.update(promoStreakConfig).set({ enabled: false });
    await betOn(instant(), userId, '2500', { rtp: '0.96' });
    await db.drizzle.db.delete(promoStreakConfig);
    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing on a product the streak does not count', async () => {
    await db.drizzle.db.update(promoStreakConfig).set({ eligibleProducts: ['live-casino'] });
    const userId = randomUUID();
    await givePlayerStreak(userId, 9, daysAgo(0));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing for the bonus-funded part of a stake', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));

    await db.drizzle.db.transaction((tx) =>
      instant().recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '2500',
        weightedAmount: '2500',
        realAmount: '1000',
        context: { ...CASINO, rtp: '0.96' },
      }),
    );

    expect(lastCredit().amount).toBe('2.000000000000000000');
  });

  it('pays a ranked player the rank rate with the uplift, never the unranked rate', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(instant(), userId, '2500', { rtp: '0.96' });

    expect(lastCredit().amount).toBe('27.500000000000000000');
  });
});

describe('streak rakeback accruals', () => {
  const claimable = () => serviceWith({ basis: 'margin', payout: 'claim' });

  beforeEach(async () => {
    await enableStreak();
  });

  it('records the unranked formula on the accrual, priced on the house edge', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(serviceWith({ basis: 'stake', payout: 'claim' }), userId, '2500', {
      rtp: '0.96',
      roundId: 'r-1',
    });

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        amount: '5.000000000000000000',
        stake: '2500.000000000000000000',
        basis: 'margin',
        rtp: '0.960000000000000000',
        ratePercent: '0.00',
        boostPercent: '0.00',
        streakMode: 'unranked',
        streakPercent: '5.00',
      }),
    ]);
  });

  it('records the uplift that raised a ranked accrual', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 3, daysAgo(0));

    await betOn(claimable(), userId, '100', { rtp: '0.96' });

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        amount: '0.220000000000000000',
        ratePercent: '5.00',
        boostPercent: '0.00',
        streakMode: 'ranked',
        streakPercent: '10.00',
      }),
    ]);
  });

  it('records no streak on an accrual the streak did not change', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await givePlayerStreak(userId, 1, daysAgo(0));

    await betOn(claimable(), userId, '100', { rtp: '0.96' });

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        amount: '0.200000000000000000',
        streakMode: null,
        streakPercent: null,
      }),
    ]);
  });

  it('reverses a streak accrual in full when its round is rolled back', async () => {
    const userId = randomUUID();
    await givePlayerStreak(userId, 3, daysAgo(0));
    await betOn(serviceWith({ basis: 'stake', payout: 'claim' }), userId, '2500', {
      rtp: '0.96',
      roundId: 'r-1',
    });

    await rollBack(claimable(), userId, 'r-1', '2500');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ status: 'reversed', streakMode: 'unranked' }),
    ]);
  });
});

describe('claimable rakeback accrual', () => {
  const claimable = () => serviceWith({ basis: 'margin', payout: 'claim' });

  it('writes an unclaimed accrual and moves no money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    const credits = await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    expect(credits).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        currency: 'USDT',
        amount: '0.200000000000000000',
        stake: '100.000000000000000000',
        basis: 'margin',
        rtp: '0.960000000000000000',
        ratePercent: '5.00',
        boostPercent: '0.00',
        gameId: 'game-1',
        providerName: 'aggregator',
        externalRoundId: 'r-1',
        status: 'accrued',
        claimId: null,
      }),
    ]);
  });

  it('keeps no rtp on a stake-basis accrual', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await betOn(serviceWith({ basis: 'stake', payout: 'claim' }), userId, '100', { rtp: '0.96' });

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ amount: '1.000000000000000000', basis: 'stake', rtp: null }),
    ]);
  });

  it('writes nothing for a bet that earns nothing', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    await betOn(claimable(), userId, '100', { rtp: '1' });

    expect(await accrualsOf(userId)).toEqual([]);
  });
});

describe('a rollback of a round with claimable rakeback', () => {
  const claimable = () => serviceWith({ basis: 'margin', payout: 'claim' });

  const markClaimed = async (accrualId: string, userId: string) => {
    const [claim] = await db.drizzle.db
      .insert(promoRakebackClaim)
      .values({ userId, idempotencyKey: randomUUID(), outcome: 'claimed' })
      .returning();
    await db.drizzle.db
      .update(promoRakebackAccrual)
      .set({ status: 'claimed', claimId: claim?.id, settledAt: new Date() })
      .where(eq(promoRakebackAccrual.id, accrualId));
  };

  it('reverses an unclaimed accrual in full', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-1', '100');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ status: 'reversed', amount: '0.200000000000000000' }),
    ]);
  });

  it('reduces an unclaimed accrual in proportion to a partial rollback', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-1', '25');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        status: 'accrued',
        stake: '75.000000000000000000',
        amount: '0.150000000000000000',
      }),
    ]);
  });

  it('keeps the stake and amount a claimed accrual was paid on', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    const [row] = await accrualsOf(userId);
    await markClaimed(row!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '100');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        status: 'claimed',
        amount: '0.200000000000000000',
        stake: '100.000000000000000000',
        rolledBackStake: '100.000000000000000000',
      }),
    ]);
  });

  it('lets a claimed newer bet absorb the rollback before it reaches an older unclaimed one', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await markClaimed(newer!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '70');

    const after = await accrualsOf(userId);
    expect(after.find((row) => row.id === newer!.id)).toMatchObject({ status: 'claimed' });
    expect(after.find((row) => row.id === older!.id)).toMatchObject({
      status: 'accrued',
      stake: '80.000000000000000000',
      amount: '0.160000000000000000',
    });
  });

  it('lets a claimed bet absorb its stake only once across repeated rollbacks', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await markClaimed(newer!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '70');
    await rollBack(claimable(), userId, 'r-1', '80');

    const after = await accrualsOf(userId);
    expect(after.find((row) => row.id === newer!.id)).toMatchObject({
      status: 'claimed',
      amount: '0.100000000000000000',
      rolledBackStake: '50.000000000000000000',
    });
    expect(after.find((row) => row.id === older!.id)).toMatchObject({ status: 'reversed' });
  });

  it('lets a voided bet absorb its own rollback without reaching an older unclaimed one', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await db.drizzle.db
      .update(promoRakebackAccrual)
      .set({ status: 'voided', voidReason: 'duplicate bet', settledAt: new Date() })
      .where(eq(promoRakebackAccrual.id, newer!.id));

    await rollBack(claimable(), userId, 'r-1', '50');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        id: older!.id,
        status: 'accrued',
        stake: '100.000000000000000000',
        amount: '0.200000000000000000',
      }),
      expect.objectContaining({
        id: newer!.id,
        status: 'voided',
        stake: '50.000000000000000000',
        rolledBackStake: '50.000000000000000000',
      }),
    ]);
  });

  it('never touches another round', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-2', '100');

    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });
});
