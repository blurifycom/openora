import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  JOB_QUEUE,
  WAGER_TRACKING,
  queue,
} from '@openora/core/contracts';
import {
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type EventBus,
  type Plugin,
} from '@openora/core/server';
import { GrantLifecycleService } from './service/grant-lifecycle.service.js';
import { GrantReaderService } from './service/grant-reader.service.js';
import { GrantService } from './service/grant.service.js';
import { WageringService } from './service/wagering.service.js';
import { createBonusRouter } from './router/index.js';

const logger = createLogger('promo-bonus');

const EXPIRY_QUEUE = queue('promo-bonus-expiry');
const EXPIRY_CRON = '*/5 * * * *';
const EmptyJobPayloadSchema = z.object({});

export default {
  id: 'bonus',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.provide(BONUS_GRANTS, (c) => new GrantService(c.get(AUDIT_WRITER)));
    ctx.provideSealed(
      BONUS_WAGERING,
      (c) => new WageringService(c.has(WAGER_TRACKING) ? c.get(WAGER_TRACKING) : undefined),
    );

    let lifecycle: GrantLifecycleService | null = null;
    let events: EventBus | null = null;

    const announce = (
      topic: 'promo.bonus.expired' | 'promo.bonus.forfeited',
      closed: Awaited<ReturnType<GrantLifecycleService['expireDue']>>,
      reason?: 'self_exclusion' | 'account_closed',
    ) => {
      for (const grant of closed) {
        events?.emit(topic, {
          userId: grant.userId,
          grantId: grant.grantId,
          currency: grant.currency,
          forfeitedAmount: grant.forfeitedAmount,
          ...(reason === undefined ? {} : { reason, actorId: null }),
        });
      }
    };

    ctx.jobs.worker({
      queue: EXPIRY_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!lifecycle) {
          logger.warn('promo-bonus-expiry sweep skipped - service not constructed');
          return;
        }
        const closed = await lifecycle.expireDue();
        announce('promo.bonus.expired', closed);
        if (closed.length > 0) {
          logger.info({ grants: closed.length }, 'promo bonus grants expired');
        }
      },
    });

    // A bonus is money a player may not keep once they have excluded themselves or closed the
    // account, and the rule is immediate rather than "by the next sweep".
    const forfeitEverything =
      (reason: 'self_exclusion' | 'account_closed') => (payload: unknown) => {
        const userId = (payload as { userId?: string }).userId;
        if (!lifecycle || userId === undefined) {
          return;
        }
        void lifecycle
          .forfeitAllFor(userId, reason)
          .then((closed) => announce('promo.bonus.forfeited', closed, reason))
          .catch((err: unknown) => logger.error({ err, userId }, 'promo bonus forfeit failed'));
      };

    ctx.events.on('rg.self_exclusion.activated', forfeitEverything('self_exclusion'));
    ctx.events.on('player.account.closed', forfeitEverything('account_closed'));

    ctx.routers.add('promo-bonus', (c) => {
      lifecycle = new GrantLifecycleService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      events = c.get(EVENT_BUS);
      void c
        .get(JOB_QUEUE)
        .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
        .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      return createBonusRouter(new GrantReaderService(c.get(DRIZZLE)));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
