import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import {
  promoPlayerStreak,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
} from '@openora/core/promo/schema/gamification';
import { flushAudit, newPlayer } from '../index.js';
import {
  RATE,
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  type WalletE2e,
} from './support/wallet.js';
import {
  bodyOf,
  fundedBettor,
  gameAdapterPlugin,
  geoIpPlugin,
  newGame,
  startedRound,
  type Bettor,
} from './support/casino.js';
import { eventually, wager } from './support/gamification-rewards.js';

const DAY_MS = 86_400_000;

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const FixedRewardSchema = z.object({
  day: z.number(),
  amount: z.string(),
  rolloverMultiplier: z.string(),
  claimExpiryDays: z.number(),
  state: z.string(),
  grantId: z.string().nullable(),
});
const MilestoneSchema = z.object({
  day: z.number(),
  unrankedRatePercent: z.string(),
  rankedUpliftPercent: z.string(),
});
const StreakViewSchema = z.object({
  enabled: z.boolean(),
  current: z.number(),
  best: z.number(),
  todayWagered: z.string(),
  dailyMinWager: z.string(),
  currency: z.string(),
  rakebackMilestones: z.array(MilestoneSchema),
  fixedRewards: z.array(FixedRewardSchema),
});
const ConfigSchema = z.object({
  enabled: z.boolean(),
  dailyMinWager: z.string(),
  eligibleProducts: z.array(z.string()),
  rakebackMilestones: z.array(MilestoneSchema),
  fixedRewards: z.array(FixedRewardSchema.omit({ state: true, grantId: true })),
});
const ClaimSchema = z.object({ outcome: z.string() });
const LeaderboardSchema = z.object({
  top: z.array(z.record(z.string(), z.unknown())),
  ownPosition: z.number().nullable(),
});

const dayOffset = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const streakConfig = {
  enabled: true,
  dailyMinWager: '3',
  eligibleProducts: ['casino'],
  rakebackMilestones: [],
  fixedRewards: [{ day: 1, amount: '15', rolloverMultiplier: '2', claimExpiryDays: 7 }],
};

const anonymousPost = (e2e: WalletE2e, path: string, body: unknown) =>
  e2e.app.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('player daily streak', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e([geoIpPlugin, gameAdapterPlugin]);
    const res = await e2e.admin.put('/backoffice/promo/streaks/config', streakConfig);
    expect(res.status).toBe(200);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  const db = () => e2e.app.container.get(DRIZZLE).db;

  const viewOf = async (client: Bettor['client']) => {
    const res = await client.get('/promo/streaks');
    expect(res.status).toBe(200);
    return StreakViewSchema.parse(await bodyOf(res));
  };

  const streakRow = async (userId: string) => {
    const [row] = await db()
      .select()
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    return row;
  };

  const milestonesOf = (userId: string) =>
    db()
      .select()
      .from(promoStreakMilestoneGrant)
      .where(eq(promoStreakMilestoneGrant.userId, userId));

  const grantsOf = (userId: string) =>
    db()
      .select()
      .from(promoGrant)
      .where(and(eq(promoGrant.userId, userId), eq(promoGrant.source, 'streak')));

  const closeDay = async (stale: string) => {
    await e2e.app.container.get(JOB_QUEUE).enqueue(queue('promo-streak-close'), {});
    await eventually(async () => {
      expect((await streakRow(stale))?.current).toBe(0);
    }, 20_000);
  };

  const reachedMilestone = async (bettor: Bettor) => {
    await db()
      .update(exchangeRateQuote)
      .set({ rate: '2', providerAsOf: new Date() })
      .where(eq(exchangeRateQuote.baseCurrency, bettor.currency));
    await wager(e2e, bettor, '2');
    const view = await viewOf(bettor.client);
    const reward = view.fixedRewards.find((entry) => entry.day === 1);
    expect(reward?.state).toBe('claimable');
    return reward?.grantId ?? '';
  };

  const claim = (client: Bettor['client'], milestoneGrantId: string) =>
    client.post('/promo/streaks/claim', { milestoneGrantId });

  it('a qualifying bet today starts a streak of one day and the player streak view shows it', async () => {
    const bettor = await fundedBettor(e2e);
    expect(await viewOf(bettor.client)).toMatchObject({ current: 0, best: 0, todayWagered: '0' });

    await wager(e2e, bettor, '2');

    const view = await viewOf(bettor.client);
    expect(view).toMatchObject({
      enabled: true,
      current: 1,
      best: 1,
      todayWagered: '3.000000000000000000',
      dailyMinWager: '3.000000000000000000',
      currency: 'USD',
    });
    expect(await streakRow(bettor.userId)).toMatchObject({
      current: 1,
      best: 1,
      lastQualifyingDay: dayOffset(0),
    });
  });

  it('a bet below the daily minimum does not start a streak', async () => {
    const bettor = await fundedBettor(e2e);

    await wager(e2e, bettor, '1');

    expect(await viewOf(bettor.client)).toMatchObject({
      current: 0,
      todayWagered: '1.500000000000000000',
    });
    expect(await streakRow(bettor.userId)).toBeUndefined();
  });

  it('a second qualifying bet on the same UTC day does not advance the streak', async () => {
    const bettor = await fundedBettor(e2e);

    await wager(e2e, bettor, '2');
    await wager(e2e, bettor, '2');

    const view = await viewOf(bettor.client);
    expect(view).toMatchObject({ current: 1, best: 1, todayWagered: '6.000000000000000000' });
    expect(await streakRow(bettor.userId)).toMatchObject({ current: 1, best: 1 });
  });

  it('a qualifying bet on the next UTC day advances the streak by one', async () => {
    const bettor = await fundedBettor(e2e);
    await wager(e2e, bettor, '2');
    await db()
      .update(promoPlayerStreak)
      .set({ lastQualifyingDay: dayOffset(-1) })
      .where(eq(promoPlayerStreak.userId, bettor.userId));
    await db()
      .update(promoStreakDailyWager)
      .set({ day: dayOffset(-1) })
      .where(eq(promoStreakDailyWager.userId, bettor.userId));

    await wager(e2e, bettor, '2');

    expect(await viewOf(bettor.client)).toMatchObject({
      current: 2,
      best: 2,
      todayWagered: '3.000000000000000000',
    });
    expect(await streakRow(bettor.userId)).toMatchObject({
      current: 2,
      best: 2,
      lastQualifyingDay: dayOffset(0),
    });
  });

  it('a missed UTC day resets the streak to zero on the daily close', async () => {
    const missed = await newPlayer(e2e.app, 'streak-missed');
    const kept = await newPlayer(e2e.app, 'streak-kept');
    await db()
      .insert(promoPlayerStreak)
      .values([
        { userId: missed.userId, current: 3, best: 3, lastQualifyingDay: dayOffset(-2) },
        { userId: kept.userId, current: 3, best: 3, lastQualifyingDay: dayOffset(-1) },
      ]);

    await closeDay(missed.userId);

    expect(await streakRow(missed.userId)).toMatchObject({ current: 0, best: 3 });
    expect(await streakRow(kept.userId)).toMatchObject({ current: 3, best: 3 });
    expect(await viewOf(missed.client)).toMatchObject({ current: 0, best: 3 });
    expect(await viewOf(kept.client)).toMatchObject({ current: 3, best: 3 });
  });

  it('a bet just before and just after UTC midnight counts as two days', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const dayBefore = new Date(midnight - DAY_MS).toISOString().slice(0, 10);
    const dayAfter = new Date(midnight).toISOString().slice(0, 10);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(midnight - 30_000));
      await startedRound(bettor, gameId, '2');
      vi.setSystemTime(new Date(midnight + 30_000));
      await startedRound(bettor, gameId, '2');
    } finally {
      vi.useRealTimers();
    }

    const days = await db()
      .select({ day: promoStreakDailyWager.day, wagered: promoStreakDailyWager.wagered })
      .from(promoStreakDailyWager)
      .where(eq(promoStreakDailyWager.userId, bettor.userId));
    expect([...days].sort((a, b) => a.day.localeCompare(b.day))).toEqual([
      { day: dayBefore, wagered: '3.000000000000000000' },
      { day: dayAfter, wagered: '3.000000000000000000' },
    ]);
    expect(await streakRow(bettor.userId)).toMatchObject({
      current: 2,
      best: 2,
      lastQualifyingDay: dayAfter,
    });
  });

  it('claiming a reached milestone credits the reward once', async () => {
    const bettor = await fundedBettor(e2e);
    const milestoneGrantId = await reachedMilestone(bettor);
    const balanceBefore = await balanceOf(e2e, bettor.userId, bettor.currency);
    expect(await grantsOf(bettor.userId)).toEqual([]);

    const res = await claim(bettor.client, milestoneGrantId);

    expect(res.status).toBe(200);
    expect(ClaimSchema.parse(await bodyOf(res))).toEqual({ outcome: 'granted' });
    const grants = await grantsOf(bettor.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      currency: bettor.currency,
      source: 'streak',
      grantedAmount: '7.500000000000000000',
      bonusBalance: '7.500000000000000000',
      wageringRequired: '15.000000000000000000',
      status: 'active',
    });
    expect(grants[0]?.sourceRef).toContain(`streak-milestone:${milestoneGrantId}:`);
    expect(await milestonesOf(bettor.userId)).toEqual([
      expect.objectContaining({ id: milestoneGrantId, outcome: 'granted' }),
    ]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(balanceBefore);
    expect((await viewOf(bettor.client)).fixedRewards[0]?.state).toBe('claimed');
    await flushAudit(e2e.app);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'promo.streak.milestone.claimed'),
          eq(auditLog.resourceId, milestoneGrantId),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it('claiming the same milestone twice is refused and credits nothing', async () => {
    const bettor = await fundedBettor(e2e);
    const milestoneGrantId = await reachedMilestone(bettor);
    const first = await claim(bettor.client, milestoneGrantId);
    expect(first.status).toBe(200);
    const [settled] = await grantsOf(bettor.userId);

    const second = await claim(bettor.client, milestoneGrantId);

    expect(second.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(second)).code).toBe('NOT_FOUND');
    const grants = await grantsOf(bettor.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: settled?.id, bonusBalance: '7.500000000000000000' });
  });

  it('claiming a milestone not yet reached is refused as not claimable', async () => {
    const bettor = await fundedBettor(e2e);
    const stranger = await fundedBettor(e2e);
    const strangerMilestone = await reachedMilestone(stranger);
    expect(await viewOf(bettor.client)).toMatchObject({
      fixedRewards: [expect.objectContaining({ day: 1, state: 'locked', grantId: null })],
    });

    const unknown = await claim(bettor.client, randomUUID());
    const foreign = await claim(bettor.client, strangerMilestone);

    for (const res of [unknown, foreign]) {
      expect(res.status).toBe(404);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
    }
    expect(await grantsOf(bettor.userId)).toEqual([]);
    expect(await grantsOf(stranger.userId)).toEqual([]);
    expect(await milestonesOf(stranger.userId)).toEqual([
      expect.objectContaining({ id: strangerMilestone, settledAt: null, outcome: null }),
    ]);
  });

  it('claiming when the payout currency rate is unavailable is refused as service unavailable', async () => {
    const bettor = await fundedBettor(e2e);
    const milestoneGrantId = await reachedMilestone(bettor);
    await db().delete(exchangeRateQuote).where(eq(exchangeRateQuote.baseCurrency, bettor.currency));

    const refused = await claim(bettor.client, milestoneGrantId);

    expect(refused.status).toBe(503);
    expect(ErrorSchema.parse(await bodyOf(refused)).code).toBe('SERVICE_UNAVAILABLE');
    expect(await grantsOf(bettor.userId)).toEqual([]);
    expect(await milestonesOf(bettor.userId)).toEqual([
      expect.objectContaining({ id: milestoneGrantId, settledAt: null, outcome: null }),
    ]);

    await db().insert(exchangeRateQuote).values({
      baseCurrency: bettor.currency,
      quoteCurrency: 'USD',
      rate: RATE,
      providerAsOf: new Date(),
    });
    const retried = await claim(bettor.client, milestoneGrantId);

    expect(retried.status).toBe(200);
    expect(await grantsOf(bettor.userId)).toHaveLength(1);
  });

  it('claiming without a session is rejected as unauthorized', async () => {
    const bettor = await fundedBettor(e2e);
    const milestoneGrantId = await reachedMilestone(bettor);

    const res = await anonymousPost(e2e, '/promo/streaks/claim', { milestoneGrantId });

    expect(res.status).toBe(401);
    expect(await grantsOf(bettor.userId)).toEqual([]);
    expect(await milestonesOf(bettor.userId)).toEqual([
      expect.objectContaining({ id: milestoneGrantId, settledAt: null }),
    ]);
  });

  it('the streak leaderboard lists players by streak length without exposing private data', async () => {
    const [first, second, third, viewer, idle] = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((label) => newPlayer(e2e.app, `streak-board-${label}`)),
    );
    if (!first || !second || !third || !viewer || !idle) {
      throw new Error('players were not created');
    }
    await db()
      .insert(promoPlayerStreak)
      .values([
        { userId: first.userId, current: 903, best: 903, lastQualifyingDay: dayOffset(0) },
        { userId: second.userId, current: 902, best: 902, lastQualifyingDay: dayOffset(0) },
        { userId: third.userId, current: 901, best: 901, lastQualifyingDay: dayOffset(0) },
        { userId: viewer.userId, current: 900, best: 900, lastQualifyingDay: dayOffset(0) },
      ]);

    const res = await viewer.client.get('/promo/streaks/leaderboard');
    const idleRes = await idle.client.get('/promo/streaks/leaderboard');

    expect(res.status).toBe(200);
    const board = LeaderboardSchema.parse(await bodyOf(res));
    expect(board.top.slice(0, 4).map((entry) => [entry.userId, entry.streak])).toEqual([
      [first.userId, 903],
      [second.userId, 902],
      [third.userId, 901],
      [viewer.userId, 900],
    ]);
    expect(board.top).toHaveLength(5);
    expect(board.ownPosition).toBe(4);
    for (const entry of board.top) {
      expect(Object.keys(entry).sort()).toEqual(['streak', 'userId', 'username']);
    }
    expect(JSON.stringify(board)).not.toContain('@e2e.test');
    expect(LeaderboardSchema.parse(await bodyOf(idleRes)).ownPosition).toBeNull();
  });
});

describe('admin streak configuration', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e();
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  const config = {
    enabled: true,
    dailyMinWager: '12',
    eligibleProducts: ['casino', 'pvp'],
    rakebackMilestones: [{ day: 3, unrankedRatePercent: '1', rankedUpliftPercent: '10' }],
    fixedRewards: [
      { day: 2, amount: '4', rolloverMultiplier: '3', claimExpiryDays: 5 },
      { day: 7, amount: '25', rolloverMultiplier: '1', claimExpiryDays: 10 },
    ],
  };

  it('an admin sets the streak config and the player view reflects the new milestones', async () => {
    const player = await newPlayer(e2e.app, 'streak-config');

    const res = await e2e.admin.put('/backoffice/promo/streaks/config', config);

    expect(res.status).toBe(200);
    const saved = ConfigSchema.parse(await bodyOf(res));
    expect(saved).toMatchObject({ enabled: true, eligibleProducts: ['casino', 'pvp'] });
    const read = ConfigSchema.parse(
      await bodyOf(await e2e.admin.get('/backoffice/promo/streaks/config')),
    );
    expect(read).toMatchObject({
      enabled: true,
      dailyMinWager: '12.000000000000000000',
      eligibleProducts: ['casino', 'pvp'],
    });
    expect(read.fixedRewards.map((entry) => [entry.day, entry.amount])).toEqual([
      [2, '4'],
      [7, '25'],
    ]);
    const view = await player.client.get('/promo/streaks');
    expect(view.status).toBe(200);
    const parsed = StreakViewSchema.parse(await bodyOf(view));
    expect(parsed).toMatchObject({ enabled: true, dailyMinWager: '12.000000000000000000' });
    expect(parsed.rakebackMilestones).toEqual([
      { day: 3, unrankedRatePercent: '1', rankedUpliftPercent: '10' },
    ]);
    expect(parsed.fixedRewards.map((entry) => [entry.day, entry.amount, entry.state])).toEqual([
      [2, '4', 'locked'],
      [7, '25', 'locked'],
    ]);
    await flushAudit(e2e.app);
    const audit = await e2e.app.container
      .get(DRIZZLE)
      .db.select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promo.streak_config.set'));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('a non-admin setting the streak config is refused as forbidden', async () => {
    const player = await newPlayer(e2e.app, 'streak-nonadmin');
    const set = await e2e.admin.put('/backoffice/promo/streaks/config', config);
    expect(set.status).toBe(200);
    const before = ConfigSchema.parse(
      await bodyOf(await e2e.admin.get('/backoffice/promo/streaks/config')),
    );

    const res = await player.client.put('/backoffice/promo/streaks/config', {
      ...config,
      dailyMinWager: '1',
      enabled: false,
    });

    expect(res.status).toBe(403);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('FORBIDDEN');
    const after = ConfigSchema.parse(
      await bodyOf(await e2e.admin.get('/backoffice/promo/streaks/config')),
    );
    expect(after).toEqual(before);
  });
});
