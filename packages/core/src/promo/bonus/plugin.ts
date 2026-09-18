import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  BonusForfeitReasonSchema,
  CurrencyTickerSchema,
  JOB_QUEUE,
  MoneyAmountSchema,
  UuidSchema,
  WAGER_TRACKING,
  domainEventSchemas,
  queue,
  type JobQueueAdapter,
} from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type DrizzleService,
  type EventBus,
  type Plugin,
} from '@openora/core/server';
import { GrantLifecycleService } from './service/grant-lifecycle.service.js';
import { GrantReaderService } from './service/grant-reader.service.js';
import { GrantService } from './service/grant.service.js';
import { OfferService } from './service/offer.service.js';
import { WageringService } from './service/wagering.service.js';
import { createBonusRouter } from './router/index.js';

const logger = createLogger('promo-bonus');

const EXPIRY_QUEUE = queue('promo-bonus-expiry');
const FORFEIT_QUEUE = queue('promo-bonus-forfeit');
const DEPOSIT_QUEUE = queue('promo-offer-deposit');
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

/**
 * A deposit turning an opt-in into a bonus is a money movement, so it runs as a durable job for
 * the same reason a forfeit does: the event that triggers it is best-effort, and a grant that
 * never gets created is a bonus the player was promised and did not receive. The grant's own
 * `(user, source, source_ref)` index makes the retry harmless.
 */
const DepositJobSchema = z.object({
  userId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  transactionId: UuidSchema,
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
    let offers: OfferService | null = null;
    let drizzle: DrizzleService | null = null;
    let events: EventBus | null = null;
    let jobs: JobQueueAdapter | null = null;

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
        announce(
          'promo.bonus.forfeited',
          closed,
          payload.reason === 'account_closed' ? 'account_closed' : 'self_exclusion',
        );
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
        void jobs
          .enqueue(
            FORFEIT_QUEUE,
            { userId, reason, actorId: actorId ?? null, actorIsAdmin },
            { idempotencyKey: `promo-bonus-forfeit:${reason}:${userId}` },
          )
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

    ctx.jobs.worker({
      queue: DEPOSIT_QUEUE,
      schema: DepositJobSchema,
      handler: async ({ payload }) => {
        if (!offers || !drizzle) {
          throw new Error('promo-offer-deposit: service not constructed');
        }
        const service = offers;
        await drizzle.db.transaction((tx) => service.applyDeposit(tx, payload));
      },
    });

    // A confirmed deposit is what turns an opt-in into a bonus.
    ctx.events.on('wallet.deposit.completed', (payload: unknown) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success) {
        logger.error('promo offer deposit skipped - event payload failed validation');
        return;
      }
      if (!jobs) {
        logger.error(
          { userId: parsed.data.userId },
          'promo offer deposit dropped - job queue not bound yet',
        );
        return;
      }
      const { userId, amount, currency, transactionId } = parsed.data;
      void jobs
        .enqueue(
          DEPOSIT_QUEUE,
          { userId, amount, currency, transactionId },
          { idempotencyKey: `promo-offer-deposit:${transactionId}` },
        )
        .catch((err: unknown) =>
          logger.error({ err, userId }, 'promo offer deposit enqueue failed'),
        );
    });

    ctx.routers.add('promo-bonus', (c) => {
      lifecycle = new GrantLifecycleService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      drizzle = c.get(DRIZZLE);
      offers = new OfferService(c.get(DRIZZLE), c.get(AUDIT_WRITER), c.get(BONUS_GRANTS));
      events = c.get(EVENT_BUS);
      jobs = c.get(JOB_QUEUE);
      void jobs
        .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
        .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      return createBonusRouter({
        grants: new GrantReaderService(c.get(DRIZZLE)),
        offers,
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
