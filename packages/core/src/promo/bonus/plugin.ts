import * as z from 'zod';
import {
  AUDIT_WRITER,
  BONUS_DEPOSITS,
  BONUS_FUND_LOCKS,
  BONUS_GRANTS,
  BONUS_GRANT_LEDGER,
  BONUS_LIFECYCLE,
  BONUS_WAGERING,
  BonusForfeitReasonSchema,
  type BonusDepositCommands,
  type BonusLifecycleCommands,
  EXCHANGE_RATE_READER,
  GEO_CHECK_COMMANDS,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  resolvePromoConfig,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  UuidSchema,
  WAGER_TRACKING,
  WALLET_COMMANDS,
  WALLET_READER,
  domainEventSchemas,
  resolveWalletTurnoverConfig,
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
  moneyCompare,
  type CoreTokenCatalog,
  type DrizzleTx,
  type Plugin,
  type TypedContainer,
} from '@openora/core/server';
import { GrantConversionService } from './service/grant-conversion.service.js';
import { GrantLifecycleService } from './service/grant-lifecycle.service.js';
import { createBonusLifecyclePort } from './service/bonus-lifecycle-port.service.js';
import { FundLockService } from './service/fund-lock.service.js';
import { PlayerFundsService } from './service/player-funds.service.js';
import { GrantReaderService, bonusGrantLedger } from './service/grant-reader.service.js';
import { GrantService } from './service/grant.service.js';
import { GrantsFindService } from './service/grants-find.service.js';
import { GrantsSummaryService } from './service/grants-summary.service.js';
import { OfferService } from './service/offer.service.js';
import { WageringService } from './service/wagering.service.js';
import { WeightService } from './service/weight.service.js';
import { bonusBalanceChannel, createBonusRouter } from './router/index.js';
import {
  grantsFindTool,
  grantsSummaryTool,
  type BonusBalanceChangeReason,
} from './contract/index.js';

const logger = createLogger('promo-bonus');

const EXPIRY_QUEUE = queue('promo-bonus-expiry');
const FORFEIT_QUEUE = queue('promo-bonus-forfeit');
const EXPIRY_CRON = '*/15 * * * *';
// Shared by every money-adjacent job in this plugin - a bare enqueue() takes the driver's
// default of one attempt, which turns one transient failure into a bonus the player earned and
// never receives. Each handler's own database guard is what makes the retry itself safe.
const MONEY_JOB_RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

// Trust-boundary narrowing for a zod-parsed event payload whose shape varies by topic: some
// forfeit-triggering events carry `initiatedBy`, some do not. `unknown` in, a known initiator out.
function initiatedByOf(data: unknown): 'player' | 'admin' | 'system' | undefined {
  if (typeof data !== 'object' || data === null || !('initiatedBy' in data)) {
    return undefined;
  }
  const value = (data as { initiatedBy: unknown }).initiatedBy;
  return value === 'player' || value === 'admin' || value === 'system' ? value : undefined;
}

const EmptyJobPayloadSchema = z.object({});

const grantConcurrency = (c: TypedContainer<CoreTokenCatalog>) =>
  resolvePromoConfig(c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined).bonus
    .grantConcurrency;

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
  requiresPorts: [PLAY_ELIGIBILITY],
  optionalPorts: [
    {
      port: EXCHANGE_RATE_READER,
      without: 'a grant in a currency other than USD has no dust threshold',
    },
  ],
  controlPorts: [
    {
      port: GEO_CHECK_COMMANDS,
      without: 'public offers are listed to visitors from refused countries',
      boundBy: 'compliance',
    },
  ],
  register(ctx) {
    ctx.provide(
      BONUS_GRANTS,
      (c) =>
        new GrantService(
          c.get(AUDIT_WRITER),
          grantConcurrency(c),
          c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
        ),
    );
    ctx.provide(BONUS_GRANT_LEDGER, () => bonusGrantLedger);
    ctx.mcp.tool(grantsSummaryTool, (c) => {
      const summary = new GrantsSummaryService(c.get(DRIZZLE));
      return (input) => summary.grantsSummary(input);
    });
    ctx.mcp.tool(grantsFindTool, (c) => {
      const grants = new GrantsFindService(c.get(DRIZZLE));
      return (input) => grants.find(input);
    });
    ctx.provideSealed(
      BONUS_WAGERING,
      (c) =>
        new WageringService(
          c.get(AUDIT_WRITER),
          c.has(WAGER_TRACKING) ? c.get(WAGER_TRACKING) : undefined,
        ),
    );
    // On the wallet's deposit transaction: the grant, and the outbox row announcing it, commit
    // with the deposit that earned it.
    ctx.provide(BONUS_DEPOSITS, (c): BonusDepositCommands => {
      const service = new OfferService(
        c.get(DRIZZLE),
        c.get(AUDIT_WRITER),
        c.get(BONUS_GRANTS),
        c.get(WALLET_READER),
        c.get(PLAY_ELIGIBILITY),
        logger,
      );
      const bus = c.get(EVENT_BUS);
      return {
        async applyDeposit(tx: DrizzleTx, deposit) {
          for (const bonus of await service.applyDeposit(tx, deposit)) {
            await bus.emitInTransaction(tx, 'promo.bonus.granted', { ...bonus, source: 'deposit' });
          }
        },
      };
    });
    // Built off the container rather than in the router factory: a job or the wallet calling
    // these ports must not depend on the router having been resolved first.
    let lifecycleSvc: GrantLifecycleService | null = null;
    const grantLifecycle = (c: TypedContainer<CoreTokenCatalog>) =>
      (lifecycleSvc ??= new GrantLifecycleService(
        c.get(DRIZZLE),
        c.get(AUDIT_WRITER),
        c.get(EVENT_BUS),
        c.get(PLAY_ELIGIBILITY),
        grantConcurrency(c),
      ));
    // A thin command port over GrantLifecycleService.forfeit - the shape an external
    // system/job context needs (no admin session to assert, one named grant rather than every
    // grant a player holds).
    ctx.provide(
      BONUS_LIFECYCLE,
      (c): BonusLifecycleCommands => createBonusLifecyclePort(grantLifecycle(c)),
    );
    ctx.provideSealed(
      BONUS_FUND_LOCKS,
      (c) =>
        new FundLockService(
          grantLifecycle(c),
          resolvePromoConfig(c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined).bonus,
        ),
    );

    let offers: OfferService | null = null;
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
    ) => realtime?.publish(bonusBalanceChannel(userId), { eventId, currency, reason });

    // Subscribed centrally rather than published beside each emit: the four topics already have
    // one producer each, and a fifth producer added later gets the signal for free instead of
    // having to remember it.
    for (const [topic, reason] of [
      ['promo.bonus.granted', 'granted'],
      ['promo.bonus.activated', 'activated'],
      ['promo.bonus.completed', 'completed'],
      ['promo.bonus.expired', 'expired'],
      ['promo.bonus.forfeited', 'forfeited'],
    ] as const) {
      ctx.events.on(topic, (payload: unknown, envelope) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success || !envelope) {
          return;
        }
        return signalBalance(parsed.data.userId, parsed.data.currency, reason, envelope.eventId);
      });
    }

    ctx.jobs.worker({
      queue: EXPIRY_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!lifecycleSvc) {
          logger.warn('promo-bonus-expiry sweep skipped - grant lifecycle not resolved yet');
          return;
        }
        const closed = await lifecycleSvc.expireDue();
        if (closed.length > 0) {
          logger.info({ grants: closed.length }, 'promo bonus grants expired');
        }
      },
    });

    ctx.jobs.worker({
      queue: FORFEIT_QUEUE,
      schema: ForfeitJobSchema,
      handler: async ({ payload }) => {
        if (!lifecycleSvc) {
          throw new Error('promo-bonus-forfeit: grant lifecycle not resolved yet');
        }
        await lifecycleSvc.forfeitAllFor(
          payload.userId,
          payload.reason,
          payload.actorId === null
            ? undefined
            : { id: payload.actorId, isAdmin: payload.actorIsAdmin },
        );
      },
    });

    // A bonus is money a player may not keep once they have excluded themselves, entered a
    // cooling-off period, closed the account or been banned, and the rule is immediate rather
    // than "by the next sweep".
    const forfeitEverything =
      <
        K extends
          | 'rg.self_exclusion.activated'
          | 'rg.cooling_off.activated'
          | 'player.account.closed'
          | 'identity.user.deactivated',
      >(
        topic: K,
        reason: 'self_exclusion' | 'cooling_off' | 'account_closed' | 'account_deactivated',
      ) =>
      async (payload: unknown) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error({ topic }, 'promo bonus forfeit skipped - event payload failed validation');
          return;
        }
        if (!jobs) {
          throw new Error(`promo bonus forfeit for '${topic}' - job queue not bound yet`);
        }
        const { userId, actorId } = parsed.data;
        // Account closure and a ban (identity.user.deactivated) are always an admin action. A
        // self-exclusion names its own initiator, which is 'player', 'admin' or 'system' - a
        // rule-triggered exclusion is nobody's admin action, and recording it as one puts the
        // wrong name on a regulator-facing audit row. Read via a type guard rather than the `in`
        // narrowing the three-topic version used - the fourth topic in this union has no
        // `initiatedBy` field at all, which collapses `parsed.data`'s inferred type to a point
        // the compiler can no longer narrow through property presence alone.
        const initiatedBy: 'player' | 'admin' | 'system' =
          topic === 'player.account.closed' || topic === 'identity.user.deactivated'
            ? 'admin'
            : (initiatedByOf(parsed.data) ?? 'system');
        // No queue idempotency key on purpose. It would have to be derived from the player and
        // the reason, and a player who excludes themselves, lets the cool-off lapse, takes a new
        // bonus and excludes themselves again produces the same key - which BullMQ drops
        // silently, leaving the second bonus active. The durable guard is the `status = 'active'`
        // claim inside `forfeitAllFor`, which already makes a redelivery write nothing twice.
        await jobs.enqueue(
          FORFEIT_QUEUE,
          {
            userId,
            reason,
            actorId: initiatedBy === 'system' ? null : actorId,
            actorIsAdmin: initiatedBy === 'admin',
          },
          MONEY_JOB_RETRY,
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
    // A ban is `identity.user.deactivated` - the admin-console "Ban" action flips `isActive`
    // false, same event chat's own membership service already reacts to for room removal.
    ctx.events.on(
      'identity.user.deactivated',
      forfeitEverything('identity.user.deactivated', 'account_deactivated'),
    );

    ctx.routers.add('promo-bonus', (c) => {
      offers = new OfferService(
        c.get(DRIZZLE),
        c.get(AUDIT_WRITER),
        c.get(BONUS_GRANTS),
        c.get(WALLET_READER),
        c.get(PLAY_ELIGIBILITY),
        logger,
        grantConcurrency(c),
      );
      jobs = c.get(JOB_QUEUE);
      realtime = c.get(REALTIME_TRANSPORT);
      void jobs
        .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
        .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      return createBonusRouter({
        grants: new GrantReaderService(c.get(DRIZZLE)),
        funds: new PlayerFundsService(
          c.get(DRIZZLE),
          c.get(WALLET_READER),
          c.get(BONUS_FUND_LOCKS),
        ),
        offers,
        realtime: c.get(REALTIME_TRANSPORT),
        weights: new WeightService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        lifecycle: grantLifecycle(c),
        conversion: new GrantConversionService(
          c.get(DRIZZLE),
          c.get(AUDIT_WRITER),
          c.get(EVENT_BUS),
          // Resolved per call: WALLET_COMMANDS is built from this module's own ports.
          () => (c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined),
          moneyCompare(
            resolveWalletTurnoverConfig(
              c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).wallet : undefined,
            ).multiplier,
            '0',
          ) > 0,
          logger,
        ),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
        geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
