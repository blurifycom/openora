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
  promoStreakMilestoneGrant,
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
) =>
  db.drizzle.db.transaction((tx) =>
    streaks.recordWager(tx, {
      userId,
      currency: 'USD',
      amount,
      weightedAmount: amount,
      realAmount,
      context,
    }),
  );

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
    for (let day = 0; day < 3; day++) {
      const row = await db.drizzle.db
        .insert(promoPlayerStreak)
        .values({ userId, current: day, best: day, lastQualifyingDay: null })
        .onConflictDoUpdate({ target: promoPlayerStreak.userId, set: { current: day, best: day } })
        .returning();
      expect(row).toHaveLength(1);
    }
    await db.drizzle.db
      .update(promoPlayerStreak)
      .set({ lastQualifyingDay: null })
      .where(eq(promoPlayerStreak.userId, userId));
    await record(userId, '10');
    const [grant] = await db.drizzle.db
      .select()
      .from(promoStreakMilestoneGrant)
      .where(eq(promoStreakMilestoneGrant.userId, userId));
    expect(grant).toMatchObject({ day: 3, settledAt: null });
  });
});

describe('closeDay', () => {
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
