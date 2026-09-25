import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  EXCHANGE_RATE_READER,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  WALLET_COMMANDS,
  WALLET_READER,
  PromoConfigSchema,
  WAGER_TRACKING,
  queue,
  type WagerTrackingArgs,
  type WagerTrackingCommands,
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
import { createGamificationRouter } from './router/index.js';
import { RankPayoutKindSchema } from './contract/index.js';

const logger = createLogger('promo-gamification');

const RANK_PAYOUT_QUEUE = queue('promo-rank-payout');
const STREAK_PAYOUT_QUEUE = queue('promo-streak-payout');
const STREAK_CLOSE_QUEUE = queue('promo-streak-close');

// The cron tick carries only which payout to run; what is owed is read from the database.
const RankPayoutJobSchema = z.object({ kind: RankPayoutKindSchema });
const EmptyJobSchema = z.object({});

/** Fans a bet out to every wager-tracking consumer this module owns, on the one sealed port. */
class CompositeWagerTracking implements WagerTrackingCommands {
  constructor(private readonly consumers: readonly WagerTrackingCommands[]) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    for (const consumer of this.consumers) {
      await consumer.recordWager(tx, args);
    }
  }
}

const rankService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), c.get(AUDIT_WRITER), logger);

const streakService = (c: TypedContainer<CoreTokenCatalog>) =>
  new StreakService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), logger);

const rakebackService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RakebackService(() => (c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined), logger);

export default {
  id: 'gamification',
  dependsOn: ['exchange-rate', 'audit'],
  register(ctx) {
    ctx.provide(
      WAGER_TRACKING,
      (c) => new CompositeWagerTracking([rankService(c), rakebackService(c), streakService(c)]),
    );

    let rankPayouts: RankPayoutService | null = null;
    let streakPayouts: StreakPayoutService | null = null;
    let streaks: StreakService | null = null;
    let events: EventBus | null = null;

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
      queue: STREAK_PAYOUT_QUEUE,
      schema: EmptyJobSchema,
      handler: async () => {
        if (!streakPayouts) {
          logger.warn({}, 'streak payout skipped - service not constructed');
          return;
        }
        const granted = await streakPayouts.settlePending();
        for (const grant of granted) {
          events?.emit('promo.bonus.granted', grant);
        }
      },
    });

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

    ctx.routers.add('promo-gamification', (c) => {
      rankPayouts = new RankPayoutService(
        c.get(DRIZZLE),
        c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        c.get(EXCHANGE_RATE_READER),
        c.get(WALLET_READER),
        logger,
      );
      streakPayouts = new StreakPayoutService(
        c.get(DRIZZLE),
        c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        logger,
        c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined,
      );
      streaks = streakService(c);
      events = c.get(EVENT_BUS);
      const schedule = PromoConfigSchema.parse(
        c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).promo : {},
      );
      const jobs = c.get(JOB_QUEUE);
      // The periodic kinds share one tick: each run pays only a period that has closed since
      // the last, so when a player is actually paid is the anchor in the ladder's settings.
      for (const [kind, cron] of [
        ['levelUp', schedule.ranks.payoutCron],
        ['daily', schedule.ranks.periodicCron],
        ['weekly', schedule.ranks.periodicCron],
        ['monthly', schedule.ranks.periodicCron],
      ] as const) {
        void jobs
          .schedule(RANK_PAYOUT_QUEUE, `promo-rank-payout.${kind}.cron`, { kind }, { cron })
          .catch((err: unknown) => logger.error({ err, kind }, 'rank payout schedule failed'));
      }
      void jobs
        .schedule(
          STREAK_PAYOUT_QUEUE,
          'promo-streak-payout.cron',
          {},
          { cron: schedule.streaks.payoutCron },
        )
        .catch((err: unknown) => logger.error({ err }, 'streak payout schedule failed'));
      void jobs
        .schedule(
          STREAK_CLOSE_QUEUE,
          'promo-streak-close.cron',
          {},
          { cron: schedule.streaks.closeCron },
        )
        .catch((err: unknown) => logger.error({ err }, 'streak close schedule failed'));

      return createGamificationRouter({
        ranks: rankService(c),
        admin: new RankAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        streaks,
        streakAdmin: new StreakAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
