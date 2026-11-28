import { withUsernames } from '../shared/rank-challenge-ladder.js';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type {
  IdentityReader,
  AuditWritePort,
  ExchangeRateReader,
  Uuid,
  WagerReversalArgs,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyCompare,
  moneySubtract,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { STREAK_CURRENCY, type PlayerStreak, type StreakLeaderboard } from '../contract/index.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';
import {
  DAY_MS,
  activeRakebackRate,
  isStreakLive,
  isoDate,
  yesterdayOf,
} from '../shared/streak-day.js';
import { fixedRewardViews, nextMilestoneAfter } from '../shared/streak-view.js';

export const StreakConfigNotSetError = makeNotFoundError('StreakConfig');

const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

type Logger = { warn: (context: object, message: string) => void };

export type StreakServiceDeps = {
  drizzle: DrizzleService;
  rates: ExchangeRateReader;
  logger: Logger;
  audit: AuditWritePort;
  identity: IdentityReader;
};

export class StreakService implements WagerTrackingCommands {
  private readonly drizzle: DrizzleService;
  private readonly rates: ExchangeRateReader;
  private readonly logger: Logger;
  private readonly audit: AuditWritePort;

  private readonly identity: IdentityReader;

  constructor(deps: StreakServiceDeps) {
    this.drizzle = deps.drizzle;
    this.rates = deps.rates;
    this.logger = deps.logger;
    this.audit = deps.audit;
    this.identity = deps.identity;
  }

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
    const [config] = await tx
      .select({
        enabled: promoStreakConfig.enabled,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        eligibleProducts: promoStreakConfig.eligibleProducts,
        fixedRewards: promoStreakConfig.fixedRewards,
      })
      .from(promoStreakConfig);
    if (
      !config?.enabled ||
      moneyCompare(config.dailyMinWager, '0') <= 0 ||
      !countsToward(config.eligibleProducts, args.context.product)
    ) {
      return [];
    }
    const amount =
      args.currency === STREAK_CURRENCY
        ? args.realAmount
        : await this.rates.convert(args.realAmount, args.currency, STREAK_CURRENCY, tx);
    if (amount === null) {
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: STREAK_CURRENCY, amount: args.realAmount },
        'streak wager skipped - no exchange rate',
      );
      return [];
    }

    const now = new Date();
    const today = isoDate(now);
    const yesterday = yesterdayOf(now);
    const [day] = await tx
      .insert(promoStreakDailyWager)
      .values({ userId: args.userId, day: today, currency: STREAK_CURRENCY, wagered: amount })
      .onConflictDoUpdate({
        target: [promoStreakDailyWager.userId, promoStreakDailyWager.day],
        set: {
          wagered: sql`CASE WHEN ${promoStreakDailyWager.currency} = ${STREAK_CURRENCY} THEN ${promoStreakDailyWager.wagered} + ${amount}::numeric ELSE ${amount}::numeric END`,
          currency: STREAK_CURRENCY,
          updatedAt: sql`now()`,
        },
      })
      .returning({ wagered: promoStreakDailyWager.wagered });
    if (args.round) {
      await tx
        .insert(promoStreakRoundWager)
        .values({
          userId: args.userId,
          providerName: args.round.providerName,
          currency: args.currency,
          externalRoundId: args.round.externalRoundId,
          day: today,
          stake: args.realAmount,
          wagered: amount,
        })
        .onConflictDoUpdate({
          target: [
            promoStreakRoundWager.userId,
            promoStreakRoundWager.providerName,
            promoStreakRoundWager.currency,
            promoStreakRoundWager.externalRoundId,
            promoStreakRoundWager.day,
          ],
          set: {
            stake: sql`${promoStreakRoundWager.stake} + ${args.realAmount}::numeric`,
            wagered: sql`${promoStreakRoundWager.wagered} + ${amount}::numeric`,
          },
        });
    }
    if (!day || moneyCompare(day.wagered, config.dailyMinWager) < 0) {
      return [];
    }

    const next = sql`(CASE WHEN ${promoPlayerStreak.lastQualifyingDay} = ${yesterday}::date THEN ${promoPlayerStreak.current} + 1 ELSE 1 END)`;
    const [advanced] = await tx
      .insert(promoPlayerStreak)
      .values({ userId: args.userId, current: 1, best: 1, lastQualifyingDay: today })
      .onConflictDoUpdate({
        target: promoPlayerStreak.userId,
        set: {
          current: next,
          best: sql`GREATEST(${promoPlayerStreak.best}, ${next})`,
          lastQualifyingDay: today,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${promoPlayerStreak.lastQualifyingDay} is distinct from ${today}::date`,
      })
      .returning({ current: promoPlayerStreak.current });
    if (!advanced) {
      return [];
    }

    const reward = config.fixedRewards.find((candidate) => candidate.day === advanced.current);
    if (reward) {
      const captured = {
        reachedAt: now,
        settledAt: null,
        outcome: null,
        announcedAt: null,
        amount: reward.amount,
        rolloverMultiplier: reward.rolloverMultiplier,
        claimExpiryDays: reward.claimExpiryDays,
        maxBet: reward.maxBet ?? null,
        expiresAt: new Date(now.getTime() + reward.claimExpiryDays * DAY_MS),
      };
      await tx
        .insert(promoStreakMilestoneGrant)
        .values({ userId: args.userId, day: advanced.current, ...captured })
        .onConflictDoUpdate({
          target: [promoStreakMilestoneGrant.userId, promoStreakMilestoneGrant.day],
          set: captured,
          setWhere: eq(promoStreakMilestoneGrant.outcome, 'reversed'),
        });
    }
    return [];
  }

  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    const rounds = await tx
      .select({
        id: promoStreakRoundWager.id,
        day: promoStreakRoundWager.day,
        stake: promoStreakRoundWager.stake,
        wagered: promoStreakRoundWager.wagered,
      })
      .from(promoStreakRoundWager)
      .where(
        and(
          eq(promoStreakRoundWager.userId, args.userId),
          eq(promoStreakRoundWager.providerName, args.round.providerName),
          eq(promoStreakRoundWager.currency, args.currency),
          eq(promoStreakRoundWager.externalRoundId, args.round.externalRoundId),
          gt(promoStreakRoundWager.stake, '0'),
        ),
      )
      .orderBy(desc(promoStreakRoundWager.day))
      .for('update');

    let remaining = args.realAmount;
    for (const round of rounds) {
      if (moneyCompare(remaining, '0') <= 0) {
        return;
      }
      const reversed = roundReversal(round, remaining);
      remaining = moneySubtract(remaining, reversed.stake);
      await tx
        .update(promoStreakRoundWager)
        .set({
          stake: sql`${promoStreakRoundWager.stake} - ${reversed.stake}::numeric`,
          wagered: sql`${promoStreakRoundWager.wagered} - ${reversed.wagered}::numeric`,
        })
        .where(eq(promoStreakRoundWager.id, round.id));
      const [day] = await tx
        .update(promoStreakDailyWager)
        .set({
          wagered: sql`GREATEST(0, ${promoStreakDailyWager.wagered} - ${reversed.wagered}::numeric)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(promoStreakDailyWager.userId, args.userId),
            eq(promoStreakDailyWager.day, round.day),
          ),
        )
        .returning({ wagered: promoStreakDailyWager.wagered });
      if (day && round.day === isoDate(new Date())) {
        await this.undoTodayIfBelowMinimum(tx, args.userId, day.wagered);
      }
    }
  }

  private async undoTodayIfBelowMinimum(tx: DrizzleTx, userId: Uuid, todayWagered: string) {
    const [config] = await tx
      .select({ dailyMinWager: promoStreakConfig.dailyMinWager })
      .from(promoStreakConfig);
    if (!config || moneyCompare(todayWagered, config.dailyMinWager) >= 0) {
      return;
    }
    const now = new Date();
    const today = isoDate(now);
    const [streak] = await tx
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(
        and(eq(promoPlayerStreak.userId, userId), eq(promoPlayerStreak.lastQualifyingDay, today)),
      )
      .for('update');
    if (!streak || streak.current < 1) {
      return;
    }
    const reached = streak.current;
    const [milestone] = await tx
      .select({
        id: promoStreakMilestoneGrant.id,
        settledAt: promoStreakMilestoneGrant.settledAt,
        outcome: promoStreakMilestoneGrant.outcome,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
      })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.userId, userId),
          eq(promoStreakMilestoneGrant.day, reached),
        ),
      )
      .for('update');
    const reachedToday = milestone !== undefined && isoDate(milestone.reachedAt) === today;
    if (reachedToday && milestone.outcome === 'granted') {
      return;
    }
    if (reachedToday && !milestone.settledAt) {
      await tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: now, outcome: 'reversed' })
        .where(eq(promoStreakMilestoneGrant.id, milestone.id));
    }
    await tx
      .update(promoPlayerStreak)
      .set({
        current: reached - 1,
        lastQualifyingDay: reached > 1 ? yesterdayOf(now) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(promoPlayerStreak.userId, userId));
  }

  async getForPlayer(userId: Uuid): Promise<PlayerStreak> {
    const db = this.drizzle.db;
    const now = new Date();
    const [config] = await db
      .select({
        enabled: promoStreakConfig.enabled,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        rakebackMilestones: promoStreakConfig.rakebackMilestones,
        fixedRewards: promoStreakConfig.fixedRewards,
      })
      .from(promoStreakConfig);
    const [rank] = await db
      .select({ tierId: promoPlayerRank.tierId })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, userId));
    const isRanked = (rank?.tierId ?? null) !== null;
    if (!config) {
      return {
        enabled: false,
        current: 0,
        best: 0,
        todayWagered: '0',
        dailyMinWager: '0',
        currency: STREAK_CURRENCY,
        isRanked,
        activeRate: null,
        nextMilestone: null,
        rakebackMilestones: [],
        fixedRewards: [],
      };
    }
    const [streak] = await db
      .select({
        current: promoPlayerStreak.current,
        best: promoPlayerStreak.best,
        lastQualifyingDay: promoPlayerStreak.lastQualifyingDay,
      })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    const [wagered] = await db
      .select({ wagered: promoStreakDailyWager.wagered })
      .from(promoStreakDailyWager)
      .where(
        and(eq(promoStreakDailyWager.userId, userId), eq(promoStreakDailyWager.day, isoDate(now))),
      );
    const grants = await db
      .select({
        id: promoStreakMilestoneGrant.id,
        day: promoStreakMilestoneGrant.day,
        amount: promoStreakMilestoneGrant.amount,
        rolloverMultiplier: promoStreakMilestoneGrant.rolloverMultiplier,
        claimExpiryDays: promoStreakMilestoneGrant.claimExpiryDays,
        maxBet: promoStreakMilestoneGrant.maxBet,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
        settledAt: promoStreakMilestoneGrant.settledAt,
        outcome: promoStreakMilestoneGrant.outcome,
        expiresAt: promoStreakMilestoneGrant.expiresAt,
      })
      .from(promoStreakMilestoneGrant)
      .where(eq(promoStreakMilestoneGrant.userId, userId));
    const counting = config.enabled && isStreakLive(streak?.lastQualifyingDay ?? null, now);
    const current = counting ? (streak?.current ?? 0) : 0;
    const rate = counting ? activeRakebackRate(config.rakebackMilestones, current) : null;
    return {
      enabled: config.enabled,
      current,
      best: streak?.best ?? 0,
      todayWagered: wagered?.wagered ?? '0',
      dailyMinWager: config.dailyMinWager,
      currency: STREAK_CURRENCY,
      isRanked,
      activeRate: rate
        ? isRanked
          ? { mode: 'ranked', percent: rate.rankedUpliftPercent }
          : { mode: 'unranked', percent: rate.unrankedRatePercent }
        : null,
      nextMilestone: config.enabled
        ? nextMilestoneAfter({
            current,
            rakebackMilestones: config.rakebackMilestones,
            fixedRewards: config.fixedRewards,
            grants,
          })
        : null,
      rakebackMilestones: config.rakebackMilestones,
      fixedRewards: fixedRewardViews(config.fixedRewards, grants, now),
    };
  }

  async leaderboard(userId: Uuid): Promise<StreakLeaderboard> {
    const top = await withUsernames(
      this.identity,
      await this.drizzle.db
        .select({ userId: promoPlayerStreak.userId, streak: promoPlayerStreak.current })
        .from(promoPlayerStreak)
        .where(gt(promoPlayerStreak.current, 0))
        .orderBy(desc(promoPlayerStreak.current))
        .limit(5),
    );

    if (top.some((row) => row.userId === userId)) {
      return { top, ownPosition: top.findIndex((row) => row.userId === userId) + 1 };
    }
    const [own] = await this.drizzle.db
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    if (!own || own.current <= 0) {
      return { top, ownPosition: null };
    }
    const [{ ahead }] = await this.drizzle.db
      .select({ ahead: sql<number>`count(*)::int` })
      .from(promoPlayerStreak)
      .where(gt(promoPlayerStreak.current, own.current));
    return { top, ownPosition: ahead + 1 };
  }

  async closeDay(now: Date): Promise<number> {
    const yesterday = yesterdayOf(now);
    await this.drizzle.db
      .delete(promoStreakRoundWager)
      .where(lt(promoStreakRoundWager.day, yesterday));
    return this.drizzle.db.transaction(async (tx) => {
      const [config] = await tx
        .select({ enabled: promoStreakConfig.enabled })
        .from(promoStreakConfig)
        .for('share');
      const disabled = !config?.enabled;
      const result = await tx
        .update(promoPlayerStreak)
        .set({
          current: 0,
          ...(disabled ? { lastQualifyingDay: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            gt(promoPlayerStreak.current, 0),
            disabled
              ? undefined
              : sql`(${promoPlayerStreak.lastQualifyingDay} is null or ${promoPlayerStreak.lastQualifyingDay} < ${yesterday}::date)`,
          ),
        );
      const reset = result.rowCount ?? 0;
      if (disabled && reset > 0) {
        await this.audit.recordInTransaction(tx, {
          actorType: 'system',
          action: 'promo.streak.runs_reset',
          resourceType: 'promo_player_streak',
          resourceId: null,
          before: { enabled: false },
          after: { reason: 'streak_disabled', reset, closedDay: yesterday },
        });
      }
      return reset;
    });
  }
}
