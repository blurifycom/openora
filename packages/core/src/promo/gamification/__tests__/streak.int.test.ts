import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { ExchangeRateReader, WagerContext } from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import { StreakService } from '../service/streak.service.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn() };
let streaks: StreakService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const SPORTSBOOK: WagerContext = { provider: 'aggregator', product: 'sportsbook' };

const CONFIG = {
  currency: 'USD',
  dailyMinWager: '10',
  eligibleProducts: ['casino'],
  milestones: [
    {
      day: 3,
      rewards: [
        {
          kind: 'bonus' as const,
          amount: '5',
          terms: { wageringMultiplier: '0.01', expiryDays: 30 },
        },
      ],
    },
    {
      day: 30,
      rewards: [
        {
          kind: 'bonus' as const,
          amount: '500',
          terms: { wageringMultiplier: '1', expiryDays: 30 },
        },
      ],
    },
  ],
  resetAfterDay: 30,
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  streaks = new StreakService(db.drizzle, mock<ExchangeRateReader>({ convert }), logger);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoStreakRoundWager);
  await db.drizzle.db.delete(promoStreakDailyWager);
  await db.drizzle.db.delete(promoPlayerStreak);
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
) =>
  db.drizzle.db.transaction((tx) =>
    streaks.recordWager(tx, {
      userId,
      currency: 'USD',
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

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const seedStreak = (userId: string, current: number, lastQualifyingDay: string) =>
  db.drizzle.db
    .insert(promoPlayerStreak)
    .values({ userId, current, best: current, lastQualifyingDay });

const milestoneOf = async (userId: string) => {
  const [grant] = await db.drizzle.db
    .select()
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.userId, userId));
  return grant;
};

describe('recordWager', () => {
  it('does not advance the streak below the daily minimum', async () => {
    const userId = randomUUID();
    await record(userId, '5');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '5.000000000000000000' });
  });

  it('advances the streak by one once the daily minimum is crossed, and only once per day', async () => {
    const userId = randomUUID();
    await record(userId, '6');
    await record(userId, '6');
    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(1);
  });

  it('ignores a sportsbook wager - only eligible products count', async () => {
    const userId = randomUUID();
    await record(userId, '50', SPORTSBOOK);
    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(0);
  });

  it('counts only the real-money part of a bonus-funded stake toward the daily minimum', async () => {
    const userId = randomUUID();
    // A 20 stake with only 5 out of the player's own funds - real money alone misses the
    // 10 daily minimum, so the streak must not advance even though the full stake would clear it.
    await record(userId, '20', CASINO, '5');
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, todayWagered: '5.000000000000000000' });
  });

  it('advances the streak off real-money stake alone once it crosses the minimum', async () => {
    const userId = randomUUID();
    await record(userId, '20', CASINO, '11');
    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(1);
  });

  it('records an unsettled milestone grant on the day it is reached', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10');
    expect(await milestoneOf(userId)).toMatchObject({ day: 3, settledAt: null });
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

  it('steps back to the previous day of the run and voids the unpaid milestone today reached', async () => {
    const userId = randomUUID();
    await seedStreak(userId, 2, daysAgo(1));
    await record(userId, '10', CASINO, '10', 'round-1');
    await rollback(userId, 'round-1', '10');

    expect((await streaks.getForPlayer(userId)).current).toBe(2);
    const voided = await milestoneOf(userId);
    expect(voided).toMatchObject({ day: 3, outcome: 'reversed' });
    expect(voided?.settledAt).not.toBeNull();

    // The run is intact, so qualifying again today reaches day 3 and reactivates the milestone.
    await record(userId, '10', CASINO, '10', 'round-2');
    expect((await streaks.getForPlayer(userId)).current).toBe(3);
    expect(await milestoneOf(userId)).toMatchObject({ day: 3, settledAt: null, outcome: null });
  });

  it('keeps the advance once the milestone it reached has already paid out', async () => {
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
    const state = await streaks.getForPlayer(userId);
    expect(state).toMatchObject({ current: 0, best: 5 });
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
    const state = await streaks.getForPlayer(userId);
    expect(state.current).toBe(5);
  });
});
