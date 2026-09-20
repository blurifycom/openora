import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  BonusForfeitReasonSchema,
  type BonusForfeitReason,
  JOB_QUEUE,
  UuidSchema,
  WAGER_TRACKING,
  domainEventSchemas,
  queue,
  type JobQueueAdapter,
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
const FORFEIT_QUEUE = queue('promo-bonus-forfeit');
const EXPIRY_CRON = '*/5 * * * *';

const EmptyJobPayloadSchema = z.object({});

/**
 * Taking a player's bonuses away is a money movement, so it runs as a durable job rather than
 * inside a best-effort event handler: a process that dies between two of a player's grants has
 * to resume, and the `status = 'active'` claim makes the retry harmless.
 */
const ForfeitJobSchema = z.object({
  userId: UuidSchema,
  reason: BonusForfeitReasonSchema,
  actorId: UuidSchema.nullable(),
  actorIsAdmin: z.boolean(),
});

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
    let jobs: JobQueueAdapter | null = null;

    const announce = (
      topic: 'promo.bonus.expired' | 'promo.bonus.forfeited',
      closed: Awaited<ReturnType<GrantLifecycleService['expireDue']>>,
      reason?: BonusForfeitReason,
    ) => {
      for (const grant of closed) {
        events?.emit(topic, {
          userId: grant.userId,
          grantId: grant.grantId,
          currency: grant.currency,
          forfeitedAmount: grant.forfeitedAmount,
          ...(reason === undefined ? {} : { reason, actorId: grant.actorId }),
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

    ctx.jobs.worker({
      queue: FORFEIT_QUEUE,
      schema: ForfeitJobSchema,
      handler: async ({ payload }) => {
        if (!lifecycle) {
          throw new Error('promo-bonus-forfeit: service not constructed');
        }
        const closed = await lifecycle.forfeitAllFor(
          payload.userId,
          payload.reason,
          payload.actorId === null
            ? undefined
            : { id: payload.actorId, isAdmin: payload.actorIsAdmin },
        );
        announce('promo.bonus.forfeited', closed, payload.reason);
      },
    });

    // A bonus is money a player may not keep once they have excluded themselves or closed the
    // account, and the rule is immediate rather than "by the next sweep".
    const forfeitEverything =
      <K extends 'rg.self_exclusion.activated' | 'player.account.closed'>(
        topic: K,
        reason: 'self_exclusion' | 'account_closed',
      ) =>
      (payload: unknown) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error({ topic }, 'promo bonus forfeit skipped - event payload failed validation');
          return;
        }
        if (!jobs) {
          logger.error({ topic }, 'promo bonus forfeit dropped - job queue not bound yet');
          return;
        }
        const { userId, actorId } = parsed.data;
        // A player excluding themselves is the actor; an account closure is always an admin.
        const actorIsAdmin =
          topic === 'player.account.closed' ||
          ('initiatedBy' in parsed.data && parsed.data.initiatedBy !== 'player');
        // No queue idempotency key on purpose. It would have to be derived from the player and
        // the reason, and a player who excludes themselves, lets the cool-off lapse, takes a new
        // bonus and excludes themselves again produces the same key - which BullMQ drops
        // silently, leaving the second bonus active. The durable guard is the `status = 'active'`
        // claim inside `forfeitAllFor`, which already makes a redelivery write nothing twice.
        void jobs
          .enqueue(FORFEIT_QUEUE, { userId, reason, actorId: actorId ?? null, actorIsAdmin })
          .catch((err: unknown) =>
            logger.error({ err, userId }, 'promo bonus forfeit enqueue failed'),
          );
      };

    ctx.events.on(
      'rg.self_exclusion.activated',
      forfeitEverything('rg.self_exclusion.activated', 'self_exclusion'),
    );
    ctx.events.on(
      'player.account.closed',
      forfeitEverything('player.account.closed', 'account_closed'),
    );

    ctx.routers.add('promo-bonus', (c) => {
      lifecycle = new GrantLifecycleService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      events = c.get(EVENT_BUS);
      jobs = c.get(JOB_QUEUE);
      void jobs
        .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
        .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      return createBonusRouter(new GrantReaderService(c.get(DRIZZLE)));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
