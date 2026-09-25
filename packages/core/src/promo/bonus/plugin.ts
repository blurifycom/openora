import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  BonusForfeitReasonSchema,
  type BonusForfeitReason,
  CurrencyTickerSchema,
  JOB_QUEUE,
  MoneyAmountSchema,
  PLAY_ELIGIBILITY,
  REALTIME_TRANSPORT,
  UuidSchema,
  WAGER_TRACKING,
  WALLET_READER,
  domainEventSchemas,
  queue,
  type JobQueueAdapter,
  type RealtimeTransport,
  type Uuid,
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
import { WeightService } from './service/weight.service.js';
import { bonusBalanceChannel, createBonusRouter } from './router/index.js';
import type { BonusBalanceChangeReason } from './contract/index.js';

const logger = createLogger('promo-bonus');

const EXPIRY_QUEUE = queue('promo-bonus-expiry');
const FORFEIT_QUEUE = queue('promo-bonus-forfeit');
const DEPOSIT_QUEUE = queue('promo-offer-deposit');
const EXPIRY_CRON = '*/15 * * * *';
// Shared by every money-adjacent job in this plugin - a bare enqueue() takes the driver's
// default of one attempt, which turns one transient failure into a bonus the player earned and
// never receives. Each handler's own database guard is what makes the retry itself safe.
const MONEY_JOB_RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

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
  requiresPorts: [PLAY_ELIGIBILITY],
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
    let realtime: RealtimeTransport | null = null;

    /**
     * A signal, never the figures: the client refetches `GET /promo/balance`, so a dropped or
     * reordered message costs nothing. Wired to the four changes a player cannot see coming -
     * a deposit's bonus arriving from a job, a requirement completing, the sweep, an admin
     * forfeiting. A bet's own progress is answered by the debit response the client already has.
     */
    const signalBalance = (
      userId: Uuid,
      currency: string,
      reason: BonusBalanceChangeReason,
      eventId: string,
    ) => {
      void realtime?.publish(bonusBalanceChannel(userId), { eventId, currency, reason });
    };

    // Subscribed centrally rather than published beside each emit: the four topics already have
    // one producer each, and a fifth producer added later gets the signal for free instead of
    // having to remember it.
    for (const [topic, reason] of [
      ['promo.bonus.granted', 'granted'],
      ['promo.bonus.completed', 'completed'],
      ['promo.bonus.expired', 'expired'],
      ['promo.bonus.forfeited', 'forfeited'],
    ] as const) {
      ctx.events.on(topic, (payload: unknown, envelope) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success || !envelope) {
          return;
        }
        signalBalance(parsed.data.userId, parsed.data.currency, reason, envelope.eventId);
      });
    }

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

    // A bonus is money a player may not keep once they have excluded themselves, entered a
    // cooling-off period or closed the account, and the rule is immediate rather than "by the
    // next sweep".
    const forfeitEverything =
      <
        K extends
          | 'rg.self_exclusion.activated'
          | 'rg.cooling_off.activated'
          | 'player.account.closed',
      >(
        topic: K,
        reason: 'self_exclusion' | 'cooling_off' | 'account_closed',
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
        // Account closure is always an admin action. A self-exclusion names its own initiator,
        // which is 'player', 'admin' or 'system' - a rule-triggered exclusion is nobody's admin
        // action, and recording it as one puts the wrong name on a regulator-facing audit row.
        const initiatedBy: 'player' | 'admin' | 'system' =
          topic === 'player.account.closed'
            ? 'admin'
            : 'initiatedBy' in parsed.data
              ? parsed.data.initiatedBy
              : 'system';
        // No queue idempotency key on purpose. It would have to be derived from the player and
        // the reason, and a player who excludes themselves, lets the cool-off lapse, takes a new
        // bonus and excludes themselves again produces the same key - which BullMQ drops
        // silently, leaving the second bonus active. The durable guard is the `status = 'active'`
        // claim inside `forfeitAllFor`, which already makes a redelivery write nothing twice.
        void jobs
          .enqueue(
            FORFEIT_QUEUE,
            {
              userId,
              reason,
              actorId: initiatedBy === 'system' ? null : actorId,
              actorIsAdmin: initiatedBy === 'admin',
            },
            MONEY_JOB_RETRY,
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
      'rg.cooling_off.activated',
      forfeitEverything('rg.cooling_off.activated', 'cooling_off'),
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
        const granted = await drizzle.db.transaction((tx) => service.applyDeposit(tx, payload));
        // After the commit: the criterion is that a player is told about the credit and what it
        // obliges them to wager, and an announcement ahead of the commit could promise a bonus
        // the transaction then rolled back.
        for (const bonus of granted) {
          events?.emit('promo.bonus.granted', { ...bonus, source: 'deposit' });
        }
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
          { idempotencyKey: `promo-offer-deposit:${transactionId}`, ...MONEY_JOB_RETRY },
        )
        .catch((err: unknown) =>
          logger.error({ err, userId }, 'promo offer deposit enqueue failed'),
        );
    });

    ctx.routers.add('promo-bonus', (c) => {
      lifecycle = new GrantLifecycleService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      drizzle = c.get(DRIZZLE);
      offers = new OfferService(
        c.get(DRIZZLE),
        c.get(AUDIT_WRITER),
        c.get(BONUS_GRANTS),
        c.get(WALLET_READER),
        c.get(PLAY_ELIGIBILITY),
        logger,
      );
      events = c.get(EVENT_BUS);
      jobs = c.get(JOB_QUEUE);
      realtime = c.get(REALTIME_TRANSPORT);
      void jobs
        .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
        .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      return createBonusRouter({
        grants: new GrantReaderService(c.get(DRIZZLE)),
        offers,
        realtime: c.get(REALTIME_TRANSPORT),
        weights: new WeightService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        lifecycle,
        events,
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
