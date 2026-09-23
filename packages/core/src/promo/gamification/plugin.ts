import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  EXCHANGE_RATE_READER,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  PromoConfigSchema,
  WAGER_TRACKING,
  queue,
} from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type EventBus,
  type Plugin,
  type TypedContainer,
} from '@openora/core/server';
import { RankAdminService } from './service/rank-admin.service.js';
import { RankPayoutService } from './service/rank-payout.service.js';
import { RankService } from './service/rank.service.js';
import { createGamificationRouter } from './router/index.js';
import { RankPayoutKindSchema } from './contract/index.js';

const logger = createLogger('promo-gamification');

const PAYOUT_QUEUE = queue('promo-rank-payout');

// The cron tick carries only which payout to run; what is owed is read from the database.
const PayoutJobSchema = z.object({ kind: RankPayoutKindSchema });

const rankService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), c.get(AUDIT_WRITER), logger);

export default {
  id: 'gamification',
  dependsOn: ['exchange-rate', 'audit'],
  register(ctx) {
    ctx.provide(WAGER_TRACKING, rankService);

    let payouts: RankPayoutService | null = null;
    let events: EventBus | null = null;

    ctx.jobs.worker({
      queue: PAYOUT_QUEUE,
      schema: PayoutJobSchema,
      handler: async ({ payload }) => {
        if (!payouts) {
          logger.warn({ kind: payload.kind }, 'rank payout skipped - service not constructed');
          return;
        }
        const granted =
          payload.kind === 'levelUp'
            ? await payouts.settleLevelUps()
            : await payouts.payPeriodic(payload.kind, new Date());
        // After each grant's own commit: announcing a bonus the transaction then rolled back
        // would tell a player about money they do not have.
        for (const grant of granted) {
          events?.emit('promo.bonus.granted', grant);
        }
      },
    });

    ctx.routers.add('promo-gamification', (c) => {
      payouts = new RankPayoutService(
        c.get(DRIZZLE),
        c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
        c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : undefined,
        c.get(EXCHANGE_RATE_READER),
        logger,
      );
      events = c.get(EVENT_BUS);
      const schedule = PromoConfigSchema.parse(
        c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).promo : {},
      ).ranks;
      const jobs = c.get(JOB_QUEUE);
      // The periodic kinds share one tick: each run pays only a period that has closed since
      // the last, so when a player is actually paid is the anchor in the ladder's settings.
      for (const [kind, cron] of [
        ['levelUp', schedule.payoutCron],
        ['daily', schedule.periodicCron],
        ['weekly', schedule.periodicCron],
        ['monthly', schedule.periodicCron],
      ] as const) {
        void jobs
          .schedule(PAYOUT_QUEUE, `promo-rank-payout.${kind}.cron`, { kind }, { cron })
          .catch((err: unknown) => logger.error({ err, kind }, 'rank payout schedule failed'));
      }

      return createGamificationRouter({
        ranks: rankService(c),
        admin: new RankAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
