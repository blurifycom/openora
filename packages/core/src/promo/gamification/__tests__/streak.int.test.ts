import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { ExchangeRateReader, WagerContext } from '@openora/core/contracts';
import { makeAuditWriter, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoRankTier,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import { StreakService } from '../service/streak.service.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn() };
const audit = makeAuditWriter();
let streaks: StreakService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const LIVE_CASINO: WagerContext = { provider: 'aggregator', product: 'live-casino' };
const SPORTSBOOK: WagerContext = { provider: 'aggregator', product: 'sportsbook' };

const DAY_MS = 86_400_000;

const CONFIG = {
  enabled: true,
  dailyMinWager: '10',
  eligibleProducts: ['casino', 'live-casino'],
  rakebackMilestones: [
    { day: 3, unrankedRatePercent: '1', rankedUpliftPercent: '5' },
    { day: 10, unrankedRatePercent: '2', rankedUpliftPercent: '10' },
  ],
  fixedRewards: [
    { day: 3, amount: '5', rolloverMultiplier: '0.01', claimExpiryDays: 7, maxBet: '2' },
    { day: 30, amount: '500', rolloverMultiplier: '1', claimExpiryDays: 14 },
    { day: 35, amount: '900', rolloverMultiplier: '2', claimExpiryDays: 30 },
  ],
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  streaks = new StreakService({
    drizzle: db.drizzle,
    rates: mock<ExchangeRateReader>({ convert }),
    logger,
    audit,
  });
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoStreakRoundWager);
  await db.drizzle.db.delete(promoStreakDailyWager);
  await db.drizzle.db.delete(promoPlayerStreak);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoStreakConfig);
  vi.clearAllMocks();
  await db.drizzle.db.insert(promoStreakConfig).values(CONFIG);
});

const record = (
  userId: string,
  amount: string,
  context: WagerContext = CASINO,
  realAmount: string = amount,
  externalRoundId?: string,
  currency = 'USD',
) =>
  db.drizzle.db.transaction((tx) =>
    streaks.recordWager(tx, {
      userId,
      currency,
      amount,
      weightedAmount: amount,
      realAmount,
      context,
      ...(externalRoundId ? { round: { providerName: 'aggregator', externalRoundId } } : {}),
    }),
  );

const rollback = (userId: string, externalRoundId: string, realAmount: string) =>
  db.drizzle.db.transaction((tx) =>
    streaks.reverseWager(tx, {
      userId,
      currency: 'USD',
      round: { providerName: 'aggregator', externalRoundId },
      realAmount,
    }),
  );

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

const seedStreak = (userId: string, current: number, lastQualifyingDay: string) =>
  db.drizzle.db
    .insert(promoPlayerStreak)
    .values({ userId, current, best: current, lastQualifyingDay });

const setConfig = (patch: Partial<typeof CONFIG>) =>
  db.drizzle.db.update(promoStreakConfig).set(patch);

const grantsOf = (userId: string) =>
  db.drizzle.db
    .select()
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.userId, userId));

const grantOnDay = async (userId: string, day: number) =>
  (await grantsOf(userId)).find((grant) => grant.day === day);

const dailyRowsOf = (userId: string) =>
  db.drizzle.db
    .select()
    .from(promoStreakDailyWager)
    .where(eq(promoStreakDailyWager.userId, userId));

const giveRank = async (userId: string) => {
  const [tier] = await db.drizzle.db
    .insert(promoRankTier)
    .values({
      key: `tier-${randomUUID()}`,
      name: 'Gold',
      position: 0,
      currency: 'USD',
      wagerThreshold: '0',
      rakebackPercent: '5',
    })
    .returning({ id: promoRankTier.id });
  await db.drizzle.db.insert(promoPlayerRank).values({ userId, currency: 'USD', tierId: tier?.id });
};

describe('what counts toward a day', () => {
  it('does not advance the streak below the daily minimum', async () => {
    const userId = randomUUID();
    await record(userId, '5');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '5.000000000000000000' });
  });

  it('qualifies a day at exactly the target and not a cent below it', async () => {
    await setConfig({ dailyMinWager: '75' });
    const short = randomUUID();
    const exact = randomUUID();

    await record(short, '74.99');
    await record(exact, '75.00');

    expect((await streaks.getForPlayer(short)).current).toBe(0);
    expect((await streaks.getForPlayer(exact)).current).toBe(1);
  });

  it('qualifies when several bets add up to the target', async () => {
    await setConfig({ dailyMinWager: '75' });
    const userId = randomUUID();
    await record(userId, '40');
    await record(userId, '34.99');
    expect((await streaks.getForPlayer(userId)).current).toBe(0);

    await record(userId, '0.01');
    expect((await streaks.getForPlayer(userId)).current).toBe(1);
  });

  it('advances the streak by one once the daily minimum is crossed, and only once per day', async () => {
    const userId = randomUUID();
    await record(userId, '6');
    await record(userId, '6');
    await record(userId, '60');
    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(1);
  });

  it('counts a day once when parallel bets each cross the minimum', async () => {
    const userId = randomUUID();
    await Promise.all([record(userId, '12'), record(userId, '12'), record(userId, '12')]);

    expect((await streaks.getForPlayer(userId)).current).toBe(1);
    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('unlocks a day reward once when parallel bets cross the minimum together', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));

    await Promise.all([record(userId, '12'), record(userId, '12'), record(userId, '12')]);

    expect((await streaks.getForPlayer(userId)).current).toBe(3);
    expect(await grantsOf(userId)).toHaveLength(1);
  });

  it.each([
    ['casino', CASINO, 1],
    ['live casino', LIVE_CASINO, 1],
    ['sportsbook', SPORTSBOOK, 0],
  ])('counts a %s stake: %s -> %s', async (_label, context, current) => {
    const userId = randomUUID();
    await record(userId, '50', context);
    expect((await streaks.getForPlayer(userId)).current).toBe(current);
  });

  it('counts every product when the product list is empty', async () => {
    await setConfig({ eligibleProducts: [] });
    const userId = randomUUID();
    await record(userId, '50', SPORTSBOOK);
    expect((await streaks.getForPlayer(userId)).current).toBe(1);
  });

  it('starts a day total kept in another currency over in dollars instead of adding to it', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoStreakDailyWager).values({
      userId,
      day: daysAgo(0),
      currency: 'EUR',
      wagered: '100',
    });

    await record(userId, '5');

    const [row] = await dailyRowsOf(userId);
    expect(row).toMatchObject({ currency: 'USD', wagered: '5.000000000000000000' });
    expect((await streaks.getForPlayer(userId)).current).toBe(0);
  });

  it('keeps adding to a day total already in dollars', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoStreakDailyWager).values({
      userId,
      day: daysAgo(0),
      currency: 'USD',
      wagered: '4',
    });

    await record(userId, '5');

    expect((await dailyRowsOf(userId))[0]?.wagered).toBe('9.000000000000000000');
  });

  it('counts only the real-money part of a bonus-funded stake toward the daily minimum', async () => {
    const userId = randomUUID();
    await record(userId, '20', CASINO, '5');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '5.000000000000000000' });
  });

  it('counts nothing for a stake funded entirely by a bonus', async () => {
    const userId = randomUUID();
    await record(userId, '50', CASINO, '0');
    expect(await dailyRowsOf(userId)).toEqual([]);
  });

  it('advances the streak off real-money stake alone once it crosses the minimum', async () => {
    const userId = randomUUID();
    await record(userId, '20', CASINO, '11');
    expect((await streaks.getForPlayer(userId)).current).toBe(1);
  });

  it('converts a stake in another currency into dollars before comparing it to the minimum', async () => {
    convert.mockResolvedValue('11');
    const userId = randomUUID();

    await record(userId, '10', CASINO, '10', undefined, 'EUR');

    expect(convert).toHaveBeenCalledWith('10', 'EUR', 'USD', expect.anything());
    expect((await streaks.getForPlayer(userId)).current).toBe(1);
  });

  it('counts nothing, and warns, when no rate converts the stake', async () => {
    convert.mockResolvedValue(null);
    const userId = randomUUID();

    await record(userId, '10', CASINO, '10', undefined, 'EUR');

    expect(logger.warn).toHaveBeenCalled();
    expect(await dailyRowsOf(userId)).toEqual([]);
  });
});

describe('a disabled streak', () => {
  it('counts nothing: no day total, no advance, no reward', async () => {
    await setConfig({ enabled: false });
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));

    await record(userId, '50', CASINO, '50', 'round-1');

    expect(await dailyRowsOf(userId)).toEqual([]);
    expect(await grantsOf(userId)).toEqual([]);
    const [streak] = await db.drizzle.db
      .select()
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    expect(streak?.current).toBe(2);
  });

  it('counts nothing when no config exists at all', async () => {
    await db.drizzle.db.delete(promoStreakConfig);
    const userId = randomUUID();

    await record(userId, '50');

    expect(await dailyRowsOf(userId)).toEqual([]);
  });

  it('reports no streak and no active rate while it is off', async () => {
    await setConfig({ enabled: false });
    const userId = randomUUID();
    await seedStreak(userId, 5, daysAgo(0));

    expect(await streaks.getForPlayer(userId)).toMatchObject({
      enabled: false,
      current: 0,
      activeRate: null,
      nextMilestone: null,
    });
  });

  it('answers an enabled:false state, not an error, when the streak was never configured', async () => {
    await db.drizzle.db.delete(promoStreakConfig);

    expect(await streaks.getForPlayer(randomUUID())).toEqual({
      enabled: false,
      current: 0,
      best: 0,
      todayWagered: '0',
      dailyMinWager: '0',
      currency: 'USD',
      isRanked: false,
      activeRate: null,
      nextMilestone: null,
      rakebackMilestones: [],
      fixedRewards: [],
    });
  });

  it('keeps a reward the player already unlocked claimable', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await setConfig({ enabled: false });

    const state = await streaks.getForPlayer(userId);
    expect(state.fixedRewards).toEqual([
      expect.objectContaining({ day: 3, state: 'claimable' }),
      expect.objectContaining({ day: 30, state: 'locked' }),
      expect.objectContaining({ day: 35, state: 'locked' }),
    ]);
  });
});

describe('unlocking a fixed reward', () => {
  it('records the reward on the day it is reached, with the terms captured', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');

    const grant = await grantOnDay(userId, 3);
    expect(grant).toMatchObject({
      settledAt: null,
      outcome: null,
      amount: '5.000000000000000000',
      rolloverMultiplier: '0.010000000000000000',
      claimExpiryDays: 7,
    });
    expect(grant?.expiresAt?.getTime()).toBe((grant?.reachedAt.getTime() ?? 0) + 7 * DAY_MS);
  });

  it('captures the max bet with the reward, and none when the reward has none', async () => {
    const limited = randomUUID();
    const unlimited = randomUUID();
    await seedStreak(limited, 2, daysAgo(1));
    await seedStreak(unlimited, 29, daysAgo(1));

    await record(limited, '10');
    await record(unlimited, '10');

    expect((await grantOnDay(limited, 3))?.maxBet).toBe('2.000000000000000000');
    expect((await grantOnDay(unlimited, 30))?.maxBet).toBeNull();
  });

  it('shows the captured max bet to the player', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await setConfig({
      fixedRewards: [{ day: 3, amount: '5', rolloverMultiplier: '1', claimExpiryDays: 7 }],
    });

    expect((await streaks.getForPlayer(userId)).fixedRewards[0]).toMatchObject({
      day: 3,
      maxBet: '2.000000000000000000',
    });
  });

  it('records nothing for a day with a rate but no fixed reward', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 9, daysAgo(1));
    await record(userId, '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(10);
    expect(await grantsOf(userId)).toEqual([]);
  });

  it('lists the unlocked reward as claimable for its player only', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    const grant = await grantOnDay(userId, 3);

    const own = await streaks.getForPlayer(userId);
    expect(own.fixedRewards[0]).toMatchObject({
      day: 3,
      state: 'claimable',
      grantId: grant?.id,
      amount: '5.000000000000000000',
    });
    expect((await streaks.getForPlayer(randomUUID())).fixedRewards[0]).toMatchObject({
      day: 3,
      state: 'locked',
      grantId: null,
    });
  });

  it('keeps a reward waiting to be claimed after the run resets', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await streaks.closeDay(new Date(Date.now() + 3 * DAY_MS));

    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(0);
    expect(state.fixedRewards[0]).toMatchObject({ day: 3, state: 'claimable' });
  });

  it('does not move the claim deadline when the run resets', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    const before = await grantOnDay(userId, 3);

    await streaks.closeDay(new Date(Date.now() + 3 * DAY_MS));

    expect((await grantOnDay(userId, 3))?.expiresAt).toEqual(before?.expiresAt);
  });

  it('shows the terms captured at unlock after the config is edited', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');

    await setConfig({
      fixedRewards: [{ day: 3, amount: '999', rolloverMultiplier: '50', claimExpiryDays: 1 }],
    });

    expect((await grantOnDay(userId, 3))?.amount).toBe('5.000000000000000000');
    expect((await streaks.getForPlayer(userId)).fixedRewards[0]).toMatchObject({
      day: 3,
      state: 'claimable',
      amount: '5.000000000000000000',
      rolloverMultiplier: '0.010000000000000000',
      claimExpiryDays: 7,
    });
  });

  it('still lists an unlocked reward after the config stops paying that day', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');

    await setConfig({ fixedRewards: [] });

    expect((await streaks.getForPlayer(userId)).fixedRewards).toEqual([
      expect.objectContaining({ day: 3, state: 'claimable' }),
    ]);
  });

  it('lists a reward past its claim window as expired before the sweep has run', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await db.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(promoStreakMilestoneGrant.userId, userId));

    expect((await streaks.getForPlayer(userId)).fixedRewards[0]?.state).toBe('expired');
  });
});

describe('a reward unlocks once per player', () => {
  const reachDayThreeAgain = async (userId: string) => {
    await db.drizzle.db
      .update(promoPlayerStreak)
      .set({ current: 2, lastQualifyingDay: daysAgo(1) })
      .where(eq(promoPlayerStreak.userId, userId));
    await record(userId, '10');
  };

  it.each([
    ['claimed', { outcome: 'granted' as const }],
    ['expired', { outcome: 'expired' as const }],
    ['lost to a responsible-gambling block', { outcome: 'restricted' as const }],
  ])('does not unlock a day again after it was %s', async (_label, settled) => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await db.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ settledAt: new Date(), ...settled })
      .where(eq(promoStreakMilestoneGrant.userId, userId));
    const first = await grantOnDay(userId, 3);

    await reachDayThreeAgain(userId);

    expect((await streaks.getForPlayer(userId)).current).toBe(3);
    expect(await grantOnDay(userId, 3)).toEqual(first);
  });

  it('leaves a reward that is still waiting exactly as it was when the day is reached again', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    const first = await grantOnDay(userId, 3);
    await setConfig({
      fixedRewards: [{ day: 3, amount: '77', rolloverMultiplier: '3', claimExpiryDays: 30 }],
    });

    await reachDayThreeAgain(userId);

    expect(await grantOnDay(userId, 3)).toEqual(first);
  });

  it('unlocks again, under the config of the moment, a day a same-day rollback took back', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    await rollback(userId, 'round-1', '10');
    expect(await grantOnDay(userId, 3)).toMatchObject({ outcome: 'reversed' });
    await setConfig({
      fixedRewards: [{ day: 3, amount: '77', rolloverMultiplier: '3', claimExpiryDays: 30 }],
    });

    await record(userId, '10', CASINO, '10', 'round-2');

    expect(await grantOnDay(userId, 3)).toMatchObject({
      settledAt: null,
      outcome: null,
      amount: '77.000000000000000000',
      claimExpiryDays: 30,
    });
  });
});

describe('beyond the last configured day', () => {
  it('keeps counting past day 35 without unlocking anything new', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 35, daysAgo(1));

    await record(userId, '10');

    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 36, best: 36 });
    expect(await grantsOf(userId)).toEqual([]);
    expect(state.activeRate).toEqual({ mode: 'unranked', percent: '2' });
    expect(state.nextMilestone).toBeNull();
  });

  it('unlocks the day-35 reward and does not reset the run', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 34, daysAgo(1));

    await record(userId, '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(35);
    expect(await grantOnDay(userId, 35)).toMatchObject({ amount: '900.000000000000000000' });
  });
});

describe('the active rate', () => {
  it('is the row with the highest day at or below the streak', async () => {
    const early = randomUUID();
    const late = randomUUID();
    await seedStreak(early, 4, daysAgo(0));
    await seedStreak(late, 12, daysAgo(0));

    expect((await streaks.getForPlayer(early)).activeRate).toEqual({
      mode: 'unranked',
      percent: '1',
    });
    expect((await streaks.getForPlayer(late)).activeRate).toEqual({
      mode: 'unranked',
      percent: '2',
    });
  });

  it('is none before the first rate row is reached', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(0));
    expect((await streaks.getForPlayer(userId)).activeRate).toBeNull();
  });

  it('is the uplift for a player holding a rank', async () => {
    const userId = randomUUID();
    await giveRank(userId);
    await seedStreak(userId, 4, daysAgo(0));

    expect(await streaks.getForPlayer(userId)).toMatchObject({
      isRanked: true,
      activeRate: { mode: 'ranked', percent: '5' },
    });
  });

  it('is the unranked rate for a player whose rank row holds no tier', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoPlayerRank).values({ userId, currency: 'USD', tierId: null });
    await seedStreak(userId, 4, daysAgo(0));

    expect(await streaks.getForPlayer(userId)).toMatchObject({
      isRanked: false,
      activeRate: { mode: 'unranked', percent: '1' },
    });
  });

  it('still applies when the player has not wagered yet today but did yesterday', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 4, daysAgo(1));
    expect((await streaks.getForPlayer(userId)).activeRate).not.toBeNull();
  });

  it('pays nothing for a broken streak even before the close job has run', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 12, daysAgo(2));

    expect(await streaks.getForPlayer(userId)).toMatchObject({
      current: 0,
      best: 12,
      activeRate: null,
    });
  });

  it('names the next day that earns a rate or a reward', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 4, daysAgo(0));

    expect((await streaks.getForPlayer(userId)).nextMilestone).toMatchObject({
      day: 10,
      rakeback: { day: 10 },
      fixedReward: null,
    });
  });
});

describe('a qualifying bet after a missed day', () => {
  it('starts a new run even before the close job has reset the old one', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 5, daysAgo(2));
    await record(userId, '10');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 1, best: 5 });
  });

  it('extends a run whose last qualifying day was yesterday', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 5, daysAgo(1));
    await record(userId, '10');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 6, best: 6 });
  });
});

describe('reverseWager', () => {
  it("undoes today's advance when a rollback takes today back under the minimum", async () => {
    const userId = randomUUID();
    await record(userId, '10', CASINO, '10', 'round-1');
    await rollback(userId, 'round-1', '10');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '0.000000000000000000' });
  });

  it('keeps the advance when what is left still clears the minimum', async () => {
    const userId = randomUUID();
    await record(userId, '10', CASINO, '10', 'round-1');
    await record(userId, '5', CASINO, '5', 'round-2');
    await rollback(userId, 'round-2', '5');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 1, todayWagered: '10.000000000000000000' });
  });

  it('never takes back more than the round counted', async () => {
    const userId = randomUUID();
    await record(userId, '12', CASINO, '12', 'round-1');
    await record(userId, '4', CASINO, '4', 'round-2');
    await rollback(userId, 'round-2', '50');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 1, todayWagered: '12.000000000000000000' });
  });

  it('takes back a partial rollback without voiding the rest of the round', async () => {
    const userId = randomUUID();
    await record(userId, '20', CASINO, '10', 'round-1');
    await rollback(userId, 'round-1', '4');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '6.000000000000000000' });
  });

  it('steps back to the previous day of the run and voids the unpaid reward today unlocked', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(2);
    const voided = await grantOnDay(userId, 3);
    expect(voided).toMatchObject({ day: 3, outcome: 'reversed' });
    expect(voided?.settledAt).not.toBeNull();

    await record(userId, '10', CASINO, '10', 'round-2');
    expect((await streaks.getForPlayer(userId)).current).toBe(3);
    expect(await grantOnDay(userId, 3)).toMatchObject({ settledAt: null, outcome: null });
  });

  it('drops the rate back when the rollback undoes the day that earned it', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    expect((await streaks.getForPlayer(userId)).activeRate).not.toBeNull();

    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).activeRate).toBeNull();
  });

  it('undoes a day beyond 35 the same way, since the run never resets', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 40, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    expect((await streaks.getForPlayer(userId)).current).toBe(41);

    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(40);
  });

  it("leaves a reward from an earlier unlock waiting when today's advance to the same day is undone", async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoStreakMilestoneGrant).values({
      userId,
      day: 3,
      reachedAt: new Date(Date.now() - 10 * DAY_MS),
      amount: '5',
      rolloverMultiplier: '1',
      claimExpiryDays: 30,
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
    });
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');

    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(2);
    expect(await grantOnDay(userId, 3)).toMatchObject({ settledAt: null, outcome: null });
  });

  it('keeps the advance once the reward it unlocked has already been claimed', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    await db.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ settledAt: new Date(), outcome: 'granted' })
      .where(eq(promoStreakMilestoneGrant.userId, userId));

    await rollback(userId, 'round-1', '10');

    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 3, todayWagered: '0.000000000000000000' });
  });

  it('only corrects the total of a day that has already ended', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 4, daysAgo(1));
    await db.drizzle.db
      .insert(promoStreakDailyWager)
      .values({ userId, day: daysAgo(1), currency: 'USD', wagered: '10' });
    await db.drizzle.db.insert(promoStreakRoundWager).values({
      userId,
      providerName: 'aggregator',
      currency: 'USD',
      externalRoundId: 'round-1',
      day: daysAgo(1),
      stake: '10',
      wagered: '10',
    });

    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(4);
    const [day] = await db.drizzle.db
      .select({ wagered: promoStreakDailyWager.wagered })
      .from(promoStreakDailyWager)
      .where(eq(promoStreakDailyWager.userId, userId));
    expect(day?.wagered).toBe('0.000000000000000000');
  });

  it('ignores a round it never counted', async () => {
    const userId = randomUUID();
    await record(userId, '10', CASINO, '10', 'round-1');
    await rollback(userId, 'round-other', '10');
    expect((await streaks.getForPlayer(userId)).current).toBe(1);
  });
});

describe('closeDay', () => {
  it('prunes round contributions from before yesterday', async () => {
    const round = (externalRoundId: string, day: string) => ({
      userId: randomUUID(),
      providerName: 'aggregator',
      currency: 'USD',
      externalRoundId,
      day,
      stake: '10',
      wagered: '10',
    });
    await db.drizzle.db
      .insert(promoStreakRoundWager)
      .values([round('old', '2020-01-03'), round('kept', '2020-01-04')]);
    await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));
    const rows = await db.drizzle.db
      .select({ externalRoundId: promoStreakRoundWager.externalRoundId })
      .from(promoStreakRoundWager);
    expect(rows).toEqual([{ externalRoundId: 'kept' }]);
  });

  it('resets a player who missed the previous UTC day, keeping their best', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoPlayerStreak).values({
      userId,
      current: 5,
      best: 5,
      lastQualifyingDay: '2020-01-01',
    });
    const reset = await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));
    expect(reset).toBe(1);
    const [row] = await db.drizzle.db
      .select({ current: promoPlayerStreak.current, best: promoPlayerStreak.best })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    expect(row).toEqual({ current: 0, best: 5 });
  });

  it('leaves a player who qualified yesterday untouched', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(promoPlayerStreak).values({
      userId,
      current: 5,
      best: 5,
      lastQualifyingDay: '2020-01-04',
    });
    await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));
    const [row] = await db.drizzle.db
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    expect(row?.current).toBe(5);
  });

  it('resets every run while the streak is disabled, even one that qualified yesterday', async () => {
    await setConfig({ enabled: false });
    const qualified = randomUUID();
    const missed = randomUUID();
    await db.drizzle.db.insert(promoPlayerStreak).values([
      { userId: qualified, current: 5, best: 9, lastQualifyingDay: '2020-01-04' },
      { userId: missed, current: 3, best: 3, lastQualifyingDay: '2020-01-01' },
    ]);

    expect(await streaks.closeDay(new Date('2020-01-05T00:05:00Z'))).toBe(2);

    const rows = await db.drizzle.db
      .select({ current: promoPlayerStreak.current, best: promoPlayerStreak.best })
      .from(promoPlayerStreak);
    expect(rows).toEqual(
      expect.arrayContaining([
        { current: 0, best: 9 },
        { current: 0, best: 3 },
      ]),
    );
  });

  it('audits, once, the runs a disabled streak reset', async () => {
    await setConfig({ enabled: false });
    await db.drizzle.db.insert(promoPlayerStreak).values([
      { userId: randomUUID(), current: 5, best: 9, lastQualifyingDay: '2020-01-04' },
      { userId: randomUUID(), current: 3, best: 3, lastQualifyingDay: '2020-01-04' },
    ]);

    await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));
    await streaks.closeDay(new Date('2020-01-05T00:06:00Z'));

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      actorType: 'system',
      action: 'promo.streak.runs_reset',
      resourceType: 'promo_player_streak',
      after: { reason: 'streak_disabled', reset: 2, closedDay: '2020-01-04' },
    });
  });

  it('writes no audit row for runs reset because the player missed a day, or when none reset', async () => {
    await db.drizzle.db
      .insert(promoPlayerStreak)
      .values({ userId: randomUUID(), current: 5, best: 5, lastQualifyingDay: '2020-01-01' });
    await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));
    await setConfig({ enabled: false });
    await streaks.closeDay(new Date('2020-01-05T00:05:00Z'));

    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('resets nothing when the audit write fails', async () => {
    await setConfig({ enabled: false });
    const userId = randomUUID();
    await seedStreak(userId, 5, '2020-01-04');
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(streaks.closeDay(new Date('2020-01-05T00:05:00Z'))).rejects.toThrow(
      /audit unavailable/,
    );

    const [row] = await db.drizzle.db
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    expect(row?.current).toBe(5);
  });

  it('resets every run when the streak was never configured', async () => {
    await db.drizzle.db.delete(promoStreakConfig);
    const userId = randomUUID();
    await db.drizzle.db
      .insert(promoPlayerStreak)
      .values({ userId, current: 5, best: 5, lastQualifyingDay: '2020-01-04' });

    expect(await streaks.closeDay(new Date('2020-01-05T00:05:00Z'))).toBe(1);
  });

  it('starts a re-enabled streak from day one', async () => {
    await setConfig({ enabled: false });
    const userId = randomUUID();
    await seedStreak(userId, 5, daysAgo(1));
    await streaks.closeDay(new Date());
    await setConfig({ enabled: true });

    await record(userId, '10');

    expect(await streaks.getForPlayer(userId)).toMatchObject({ current: 1, best: 5 });
  });

  it('keeps a waiting reward claimable while the close resets a disabled streak', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    await setConfig({ enabled: false });

    await streaks.closeDay(new Date());

    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(0);
    expect(state.fixedRewards[0]).toMatchObject({ day: 3, state: 'claimable' });
  });
});
