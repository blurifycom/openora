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
  IDENTITY_READER,
  PLAY_ELIGIBILITY,
  resolvePromoConfig,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  UuidSchema,
  WAGER_TRACKING,
  WALLET_COMMANDS,
  WALLET_READER,
  domainEventSchemas,
  isTurnoverEnabled,
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
const MONEY_JOB_RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

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

const ForfeitJobSchema = z.object({
  userId: UuidSchema,
  reason: BonusForfeitReasonSchema,
  actorId: UuidSchema.nullable(),
  actorIsAdmin: z.boolean(),
});

export default {
  id: 'bonus',
  dependsOn: ['audit'],
  requiresPorts: [PLAY_ELIGIBILITY, IDENTITY_READER],
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
      const grants = new GrantsFindService(c.get(DRIZZLE), c.get(IDENTITY_READER));
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
    let lifecycleSvc: GrantLifecycleService | null = null;
    const grantLifecycle = (c: TypedContainer<CoreTokenCatalog>) =>
      (lifecycleSvc ??= new GrantLifecycleService(
        c.get(DRIZZLE),
        c.get(AUDIT_WRITER),
        c.get(EVENT_BUS),
        c.get(PLAY_ELIGIBILITY),
        grantConcurrency(c),
      ));
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

    const signalBalance = (
      userId: Uuid,
      currency: string,
      reason: BonusBalanceChangeReason,
      eventId: string,
    ) => realtime?.publish(bonusBalanceChannel(userId), { eventId, currency, reason });

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
        const initiatedBy: 'player' | 'admin' | 'system' =
          topic === 'player.account.closed' || topic === 'identity.user.deactivated'
            ? 'admin'
            : (initiatedByOf(parsed.data) ?? 'system');
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
    ctx.events.on(
      'identity.user.deactivated',
      forfeitEverything('identity.user.deactivated', 'account_deactivated'),
    );

    ctx.routers.add('promo-bonus', (c, options) => {
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
      if (options?.mounted !== false) {
        void jobs
          .schedule(EXPIRY_QUEUE, 'promo-bonus-expiry.cron', {}, { cron: EXPIRY_CRON })
          .catch((err: unknown) => logger.error({ err }, 'promo-bonus-expiry schedule failed'));
      }
      return createBonusRouter({
        grants: new GrantReaderService(c.get(DRIZZLE), c.get(IDENTITY_READER)),
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
          () => (c.has(WALLET_COMMANDS) ? c.get(WALLET_COMMANDS) : undefined),
          isTurnoverEnabled(
            resolveWalletTurnoverConfig(
              c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).wallet : undefined,
            ),
          ),
          logger,
          c.get(IDENTITY_READER),
        ),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
        geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
