import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  EXCHANGE_RATE_READER,
  IDENTITY_READER,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  WALLET_COMMANDS,
  WALLET_READER,
  PromoConfigSchema,
  UuidSchema,
  WAGER_TRACKING,
  domainEventSchemas,
  queue,
  resolveWalletDefaultCurrency,
  type IdentityReader,
  type JobQueueAdapter,
  type SettledWagerArgs,
  type WagerReversalArgs,
  type WagerTrackingArgs,
  type WagerTrackingCommands,
  type WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type DrizzleTx,
  type EventBus,
  type Plugin,
  type TypedContainer,
} from '@openora/core/server';
import { RakebackService } from './service/rakeback.service.js';
import { RankAdminService } from './service/rank-admin.service.js';
import { RankPayoutService } from './service/rank-payout.service.js';
import { RankService } from './service/rank.service.js';
import { StreakAdminService } from './service/streak-admin.service.js';
import { StreakPayoutService } from './service/streak-payout.service.js';
import { StreakService } from './service/streak.service.js';
import { RaceAdminService } from './service/race-admin.service.js';
import { RacePayoutService } from './service/race-payout.service.js';
import { RaceService } from './service/race.service.js';
import { RankChallengeService } from './service/rank-challenge.service.js';
import { RankChallengeAdminService } from './service/rank-challenge-admin.service.js';
import { RankChallengePayoutService } from './service/rank-challenge-payout.service.js';
import { createGamificationRouter } from './router/index.js';
import {
  RankPayoutKindSchema,
  StreakForfeitReasonSchema,
  type StreakForfeitReason,
} from './contract/index.js';

const logger = createLogger('promo-gamification');

const RANK_PAYOUT_QUEUE = queue('promo-rank-payout');
const STREAK_PAYOUT_QUEUE = queue('promo-streak-payout');
const STREAK_ANNOUNCE_QUEUE = queue('promo-streak-announce');
const STREAK_CLOSE_QUEUE = queue('promo-streak-close');
const STREAK_FORFEIT_QUEUE = queue('promo-streak-forfeit');
const RACE_PAYOUT_QUEUE = queue('promo-race-payout');
const RANK_CHALLENGE_PAYOUT_QUEUE = queue('promo-rank-challenge-payout');
const RANK_ANNOUNCE_QUEUE = queue('promo-rank-announce');
const RANK_PERIOD_PRUNE_QUEUE = queue('promo-rank-period-prune');
// Races close at whatever timestamp the operator configured, not a shared daily/weekly/monthly
// anchor - a short recurring tick is what makes "closed within a minute of endAt" true.
const RACE_PAYOUT_CRON = '*/1 * * * *';
// A claim can land at any moment (it is detected inline on the bet that crosses a threshold),
// so settling it - the cash credit and the win announcement - runs on the same short tick.
const RANK_CHALLENGE_PAYOUT_CRON = '*/1 * * * *';
const RANK_ANNOUNCE_CRON = '*/1 * * * *';
const STREAK_ANNOUNCE_CRON = '*/1 * * * *';
const RANK_PERIOD_PRUNE_CRON = '30 3 * * *';

// The cron tick carries only which payout to run; what is owed is read from the database.
const RankPayoutJobSchema = z.object({ kind: RankPayoutKindSchema });
const EmptyJobSchema = z.object({});

/**
 * Forfeiting a player's unclaimed streak rewards when a responsible-gambling block starts runs as
 * a retried job, not inside the best-effort event handler: a failure there would leave the
 * rewards claimable once the block lapses. The `settledAt is null` claim makes a retry harmless.
 */
const StreakForfeitJobSchema = z.object({
  userId: UuidSchema,
  reason: StreakForfeitReasonSchema,
  actorId: UuidSchema.nullable(),
  actorIsAdmin: z.boolean(),
});
const FORFEIT_JOB_RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

/** Fans a bet out to every wager-tracking consumer this module owns, on the one sealed port. */
class CompositeWagerTracking implements WagerTrackingCommands {
  constructor(private readonly consumers: readonly WagerTrackingCommands[]) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    const credits: WagerTrackingWalletCredit[] = [];
    for (const consumer of this.consumers) {
      credits.push(...(await consumer.recordWager(tx, args)));
    }
    return credits;
  }

  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    for (const consumer of this.consumers) {
      await consumer.reverseWager?.(tx, args);
    }
  }

  async recordSettledWager(tx: DrizzleTx, args: SettledWagerArgs): Promise<void> {
    for (const consumer of this.consumers) {
      await consumer.recordSettledWager?.(tx, args);
    }
  }

  async reverseSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    for (const consumer of this.consumers) {
      await consumer.reverseSettledWager?.(tx, args);
    }
  }
}

const rankService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), c.get(AUDIT_WRITER), logger);

const streakService = (c: TypedContainer<CoreTokenCatalog>) =>
  new StreakService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), logger);

const raceService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RaceService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), logger);

const rakebackService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RakebackService(() => (c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined), logger);

const rankChallengeService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankChallengeService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), logger);

export default {
  id: 'gamification',
  dependsOn: ['exchange-rate', 'audit'],
  register(ctx) {
    ctx.provide(
      WAGER_TRACKING,
      (c) =>
        new CompositeWagerTracking([
          rankService(c),
          rakebackService(c),
          streakService(c),
          raceService(c),
          rankChallengeService(c),
        ]),
    );

    let rankPayouts: RankPayoutService | null = null;
    let streakPayouts: StreakPayoutService | null = null;
    let racePayouts: RacePayoutService | null = null;
    let rankChallengePayouts: RankChallengePayoutService | null = null;
    let streaks: StreakService | null = null;
    let events: EventBus | null = null;
    let identityReader: IdentityReader | null = null;
    let jobs: JobQueueAdapter | null = null;

    const emitCashCredit = async (args: {
      userId: string;
      amount: string;
      currency: string;
      transactionId: string | null;
    }) => {
      // Null when nothing moved (a replayed credit already announced the first time).
      if (!args.transactionId) {
        return;
      }
      const playerId = (await identityReader?.getPlayerIdByUserIdSafe(args.userId)) ?? null;
      events?.emit('wallet.balance.changed', {
        userId: args.userId,
        playerId,
        amount: args.amount,
        currency: args.currency,
        transactionId: args.transactionId,
        type: 'cashback',
        direction: 'credit',
      });
    };

    ctx.jobs.worker({
      queue: RANK_PAYOUT_QUEUE,
      schema: RankPayoutJobSchema,
      handler: async ({ payload }) => {
        if (!rankPayouts) {
          logger.warn({ kind: payload.kind }, 'rank payout skipped - service not constructed');
          return;
        }
        const granted =
          payload.kind === 'levelUp'
            ? await rankPayouts.settleLevelUps()
            : await rankPayouts.payPeriodic(payload.kind, new Date());
        // After each grant's own commit: announcing a bonus the transaction then rolled back
        // would tell a player about money they do not have.
        for (const grant of granted) {
          events?.emit('promo.bonus.granted', grant);
        }
      },
    });

    ctx.jobs.worker({
      queue: RANK_ANNOUNCE_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!rankPayouts) {
          logger.warn({}, 'rank announcement skipped - service not constructed');
          return;
        }
        for (const change of await rankPayouts.announceRankChanges()) {
          events?.emit('promo.rank.changed', change);
        }
      },
    });

    ctx.jobs.worker({
      queue: RANK_PERIOD_PRUNE_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!rankPayouts) {
          logger.warn({}, 'rank period prune skipped - service not constructed');
          return;
        }
        const count = await rankPayouts.pruneSettledPeriodWagers();
        logger.info({ count }, 'rank period counters pruned');
      },
    });

    ctx.jobs.worker({
      queue: STREAK_ANNOUNCE_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!streakPayouts) {
          logger.warn({}, 'streak announcement skipped - service not constructed');
          return;
        }
        await streakPayouts.announceReached((reached) =>
          events?.emit('promo.streak.milestone.reached', reached),
        );
      },
    });

    ctx.jobs.worker({
      queue: STREAK_FORFEIT_QUEUE,
      schema: StreakForfeitJobSchema,
      handler: async ({ payload }) => {
        if (!streakPayouts) {
          throw new Error('promo-streak-forfeit: service not constructed');
        }
        const forfeited = await streakPayouts.forfeitUnclaimed({
          userId: payload.userId,
          reason: payload.reason,
          actor:
            payload.actorId === null
              ? null
              : { id: payload.actorId, isAdmin: payload.actorIsAdmin },
        });
        if (forfeited > 0) {
          logger.info(
            { userId: payload.userId, forfeited, reason: payload.reason },
            'unclaimed streak rewards forfeited',
          );
        }
      },
    });

    const forfeitUnclaimedStreakRewards =
      (
        topic: 'rg.self_exclusion.activated' | 'rg.cooling_off.activated',
        reason: StreakForfeitReason,
      ) =>
      (payload: unknown) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error(
            { topic },
            'streak reward forfeit skipped - event payload failed validation',
          );
          return;
        }
        if (!jobs) {
          logger.error({ topic }, 'streak reward forfeit dropped - job queue not bound yet');
          return;
        }
        const { userId, actorId, initiatedBy } = parsed.data;
        // No queue idempotency key, for the reason the bonus forfeit gives: a second block after
        // the first lapsed would derive the same key and be dropped. The durable guard is the
        // `settledAt is null` claim inside `forfeitUnclaimed`.
        void jobs
          .enqueue(
            STREAK_FORFEIT_QUEUE,
            {
              userId,
              reason,
              actorId: initiatedBy === 'system' ? null : actorId,
              actorIsAdmin: initiatedBy === 'admin',
            },
            FORFEIT_JOB_RETRY,
          )
          .catch((err: unknown) =>
            logger.error({ err, userId }, 'streak reward forfeit enqueue failed'),
          );
      };
    ctx.events.on(
      'rg.self_exclusion.activated',
      forfeitUnclaimedStreakRewards('rg.self_exclusion.activated', 'self_exclusion'),
    );
    ctx.events.on(
      'rg.cooling_off.activated',
      forfeitUnclaimedStreakRewards('rg.cooling_off.activated', 'cooling_off'),
    );

    ctx.jobs.worker({
      queue: STREAK_CLOSE_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!streaks) {
          logger.warn({}, 'streak close skipped - service not constructed');
          return;
        }
        const reset = await streaks.closeDay(new Date());
        if (reset > 0) {
          logger.warn({ reset }, 'streak close reset players who missed their qualifying day');
        }
      },
    });

    ctx.jobs.worker({
      queue: RACE_PAYOUT_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!racePayouts) {
          logger.warn({}, 'race payout skipped - service not constructed');
          return;
        }
        const won = await racePayouts.closeDue(new Date());
        // After the settlement transaction's own commit, the same rule the rank/streak payouts
        // follow: a winner announced before the credit lands would tell a player about a prize
        // they do not have yet.
        for (const win of won) {
          events?.emit('promo.race.won', win);
          await emitCashCredit(win);
        }
      },
    });

    ctx.jobs.worker({
      queue: RANK_CHALLENGE_PAYOUT_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!rankChallengePayouts) {
          logger.warn({}, 'rank challenge payout skipped - service not constructed');
          return;
        }
        const won = await rankChallengePayouts.settlePending();
        // Same rule as every other payout job here: announce only after the settlement
        // transaction that credited the cash (if any) has committed.
        for (const win of won) {
          events?.emit('promo.rank-challenge.won', win);
          if (win.cashAmount !== null) {
            await emitCashCredit({
              userId: win.userId,
              amount: win.cashAmount,
              currency: win.currency,
              transactionId: win.transactionId,
            });
          }
        }
      },
    });

    ctx.routers.add('promo-gamification', (c) => {
      // A cash prize/cashback credit lands here when its own source (a race, a rank challenge
      // tier, a streak milestone) is priced in something else - see `priceForPayout`.
      const payoutCurrency = resolveWalletDefaultCurrency(
        c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).wallet : undefined,
      );
      rankPayouts = new RankPayoutService(
        c.get(DRIZZLE),
        c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        c.get(EXCHANGE_RATE_READER),
        c.get(WALLET_READER),
        logger,
      );
      streakPayouts = new StreakPayoutService({
        drizzle: c.get(DRIZZLE),
        grants: c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
        eligibility: c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        rates: c.get(EXCHANGE_RATE_READER),
        walletReader: c.get(WALLET_READER),
        payoutCurrency,
        audit: c.get(AUDIT_WRITER),
        logger,
        wallet: c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined,
      });
      racePayouts = new RacePayoutService(
        c.get(DRIZZLE),
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined,
        c.get(EXCHANGE_RATE_READER),
        payoutCurrency,
        c.get(AUDIT_WRITER),
        logger,
      );
      rankChallengePayouts = new RankChallengePayoutService(
        c.get(DRIZZLE),
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined,
        c.get(EXCHANGE_RATE_READER),
        payoutCurrency,
        c.get(AUDIT_WRITER),
        logger,
      );
      streaks = streakService(c);
      events = c.get(EVENT_BUS);
      identityReader = c.get(IDENTITY_READER);
      const schedule = PromoConfigSchema.parse(
        c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).promo : {},
      );
      const jobQueue = c.get(JOB_QUEUE);
      jobs = jobQueue;
      // The periodic kinds share one tick: each run pays only a period that has closed since
      // the last, so when a player is actually paid is the anchor in the ladder's settings.
      for (const [kind, cron] of [
        ['levelUp', schedule.ranks.payoutCron],
        ['daily', schedule.ranks.periodicCron],
        ['weekly', schedule.ranks.periodicCron],
        ['monthly', schedule.ranks.periodicCron],
      ] as const) {
        void jobQueue
          .schedule(RANK_PAYOUT_QUEUE, `promo-rank-payout.${kind}.cron`, { kind }, { cron })
          .catch((err: unknown) => logger.error({ err, kind }, 'rank payout schedule failed'));
      }
      // Milestone rewards are claimed by the player now; drop the schedule that used to pay them.
      void jobQueue
        .unschedule(STREAK_PAYOUT_QUEUE, 'promo-streak-payout.cron')
        .catch((err: unknown) => logger.error({ err }, 'streak payout unschedule failed'));
      void jobQueue
        .schedule(
          STREAK_ANNOUNCE_QUEUE,
          'promo-streak-announce.cron',
          {},
          { cron: STREAK_ANNOUNCE_CRON },
        )
        .catch((err: unknown) => logger.error({ err }, 'streak announcement schedule failed'));
      void jobQueue
        .schedule(
          STREAK_CLOSE_QUEUE,
          'promo-streak-close.cron',
          {},
          { cron: schedule.streaks.closeCron },
        )
        .catch((err: unknown) => logger.error({ err }, 'streak close schedule failed'));
      void jobQueue
        .schedule(RACE_PAYOUT_QUEUE, 'promo-race-payout.cron', {}, { cron: RACE_PAYOUT_CRON })
        .catch((err: unknown) => logger.error({ err }, 'race payout schedule failed'));
      void jobQueue
        .schedule(
          RANK_CHALLENGE_PAYOUT_QUEUE,
          'promo-rank-challenge-payout.cron',
          {},
          { cron: RANK_CHALLENGE_PAYOUT_CRON },
        )
        .catch((err: unknown) => logger.error({ err }, 'rank challenge payout schedule failed'));
      void jobQueue
        .schedule(RANK_ANNOUNCE_QUEUE, 'promo-rank-announce.cron', {}, { cron: RANK_ANNOUNCE_CRON })
        .catch((err: unknown) => logger.error({ err }, 'rank announcement schedule failed'));
      void jobQueue
        .schedule(
          RANK_PERIOD_PRUNE_QUEUE,
          'promo-rank-period-prune.cron',
          {},
          { cron: RANK_PERIOD_PRUNE_CRON },
        )
        .catch((err: unknown) => logger.error({ err }, 'rank period prune schedule failed'));

      return createGamificationRouter({
        ranks: rankService(c),
        admin: new RankAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        streaks,
        streakPayouts,
        onStreakClaimed: async ({ granted, cashPaid }) => {
          try {
            for (const grant of granted) {
              events?.emit('promo.bonus.granted', grant);
            }
            for (const paid of cashPaid) {
              await emitCashCredit(paid);
            }
          } catch (err) {
            logger.error({ err }, 'streak claim announcement failed after the claim committed');
          }
        },
        streakAdmin: new StreakAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        races: raceService(c),
        raceAdmin: new RaceAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        rankChallenge: rankChallengeService(c),
        rankChallengeAdmin: new RankChallengeAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
