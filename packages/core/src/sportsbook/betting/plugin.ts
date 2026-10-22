import { ADMIN_GUARD, DRIZZLE, EVENT_BUS, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  AUDIT_WRITER,
  EXCHANGE_RATE_READER,
  GEO_CHECK_COMMANDS,
  IDENTITY_READER,
  JOB_QUEUE,
  PLAY_ELIGIBILITY,
  SPORTSBOOK_LEDGER,
  SPORTSBOOK_PROVIDER,
  SportsbookProviderNameSchema,
  WALLET_COMMANDS,
  WALLET_READER,
  domainEventSchemas,
  type JobQueueAdapter,
} from '@openora/core/contracts';
import {
  SPORTSBOOK_RECONCILE_CRON,
  SPORTSBOOK_RECONCILE_QUEUE,
  SPORTSBOOK_RG_REVOKE_QUEUE,
  SPORTSBOOK_RG_REVOKE_TRIGGERS,
  SportsbookReconcileJobSchema,
  SportsbookRgRevokeJobSchema,
} from './contract/index.js';
import { createSportsbookRouter } from './router/index.js';
import { SportsbookAlignService } from './service/align.service.js';
import { SportsbookBetQueryService } from './service/bet-query.service.js';
import { SportsbookConfigService } from './service/config.service.js';
import { SportsbookDebtService } from './service/debt.service.js';
import { SportsbookFindingService } from './service/finding.service.js';
import { SportsbookLedgerService } from './service/ledger.service.js';
import { SportsbookReconcileService } from './service/reconcile.service.js';
import { SportsbookRestrictionService } from './service/restriction.service.js';
import { SportsbookSessionService } from './service/session.service.js';

const logger = createLogger('sportsbook');

const RG_REVOKE_RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

type SportsbookServices = {
  align: SportsbookAlignService;
  bets: SportsbookBetQueryService;
  config: SportsbookConfigService;
  debts: SportsbookDebtService;
  findings: SportsbookFindingService;
  ledger: SportsbookLedgerService;
  reconcile: SportsbookReconcileService;
  restrictions: SportsbookRestrictionService;
  sessions: SportsbookSessionService;
};

export default {
  id: 'betting',
  requiresPorts: [PLAY_ELIGIBILITY, IDENTITY_READER, WALLET_COMMANDS, WALLET_READER],
  dependsOn: ['wallet', 'audit', 'identity'],
  register(ctx) {
    // SPORTSBOOK_PROVIDER is bound by the operator's overlay; core ships none.
    let ref: SportsbookServices | null = null;
    let jobs: JobQueueAdapter | null = null;
    const services = (c: TypedContainer<CoreTokenCatalog>): SportsbookServices => {
      if (!ref) {
        const drizzle = c.get(DRIZZLE);
        const events = c.get(EVENT_BUS);
        const audit = c.get(AUDIT_WRITER);
        const identity = c.get(IDENTITY_READER);
        const playEligibility = c.get(PLAY_ELIGIBILITY);
        const walletReader = c.get(WALLET_READER);
        const provider = c.has(SPORTSBOOK_PROVIDER) ? c.get(SPORTSBOOK_PROVIDER) : undefined;
        if (provider) {
          SportsbookProviderNameSchema.parse(provider.name);
        }
        const wallet = c.get(WALLET_COMMANDS);
        const config = new SportsbookConfigService(drizzle, audit);
        const debts = new SportsbookDebtService({ drizzle, events, audit, identity, wallet });
        const sessions = new SportsbookSessionService({
          drizzle,
          audit,
          config,
          playEligibility,
          walletReader,
          geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
          provider,
        });
        const ledger = new SportsbookLedgerService({
          drizzle,
          events,
          audit,
          config,
          sessions,
          debts,
          playEligibility,
          identity,
          wallet,
          walletReader,
          rates: c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
        });
        const align = new SportsbookAlignService({ drizzle, ledger, audit, provider });
        ref = {
          align,
          bets: new SportsbookBetQueryService(drizzle, identity, walletReader),
          config,
          debts,
          findings: new SportsbookFindingService(drizzle, audit),
          ledger,
          reconcile: new SportsbookReconcileService(drizzle, config, align),
          restrictions: new SportsbookRestrictionService({
            drizzle,
            events,
            audit,
            identity,
            sessions,
          }),
          sessions,
        };
      }
      return ref;
    };

    ctx.provide(SPORTSBOOK_LEDGER, (c) => services(c).ledger);

    for (const topic of SPORTSBOOK_RG_REVOKE_TRIGGERS) {
      ctx.events.on(topic, async (payload, envelope) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error({ topic }, 'sportsbook: RG session revoke could not be queued');
          return;
        }
        if (!jobs) {
          throw new Error('sportsbook RG revoke: job queue not resolved yet');
        }
        const { userId } = parsed.data;
        await jobs.enqueue(
          SPORTSBOOK_RG_REVOKE_QUEUE,
          { userId, trigger: topic },
          {
            ...RG_REVOKE_RETRY,
            ...(envelope ? { idempotencyKey: `sportsbook-rg-revoke:${envelope.eventId}` } : {}),
          },
        );
      });
    }

    ctx.jobs.worker({
      queue: SPORTSBOOK_RG_REVOKE_QUEUE,
      schema: SportsbookRgRevokeJobSchema,
      handler: async ({ payload }) => {
        if (!ref) {
          throw new Error('sportsbook RG revoke: service not constructed yet');
        }
        await ref.sessions.revokeAll(payload.userId, payload.trigger);
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error({ err: error, jobId: jobCtx.id }, 'sportsbook: RG session revoke failed');
      },
    });

    ctx.jobs.worker({
      queue: SPORTSBOOK_RECONCILE_QUEUE,
      schema: SportsbookReconcileJobSchema,
      handler: async () => {
        if (!ref) {
          throw new Error('sportsbook reconcile: service not constructed yet');
        }
        const [summary, ineligible, revokes] = await Promise.allSettled([
          ref.reconcile.run(),
          ref.sessions.revokeIneligible(),
          ref.sessions.retryProviderRevokes(),
        ]);
        if (summary.status === 'rejected') {
          throw summary.reason;
        }
        if (ineligible.status === 'rejected') {
          throw ineligible.reason;
        }
        if (revokes.status === 'rejected') {
          throw revokes.reason;
        }
        logger.info(
          { ...summary.value, ineligibleRevoked: ineligible.value, revokesRetried: revokes.value },
          'sportsbook reconcile pass done',
        );
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error({ err: error, jobId: jobCtx.id }, 'sportsbook reconcile pass failed');
      },
    });

    ctx.routers.add('sportsbook', (c) => {
      jobs = c.get(JOB_QUEUE);
      void jobs
        .schedule(
          SPORTSBOOK_RECONCILE_QUEUE,
          'sportsbook-reconcile.cron',
          {},
          {
            cron: SPORTSBOOK_RECONCILE_CRON,
          },
        )
        .catch((err: unknown) => logger.error({ err }, 'sportsbook reconcile schedule failed'));
      return createSportsbookRouter({ ...services(c), adminGuard: c.get(ADMIN_GUARD) });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
