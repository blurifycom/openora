import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CACHE,
  EXCHANGE_RATE_READER,
  GEO_IP_ADAPTER,
  GEO_CHECK_COMMANDS,
  JOB_QUEUE,
  KYC_ADAPTER,
  IDENTITY_READER,
  KYC_STATUS_WRITER,
  KYC_VENDOR_STATUSES,
  KYC_WEBHOOK_VERIFIER,
  KycTierSchema,
  LOGIN_ENFORCEMENT,
  MAIL_DISPATCH,
  PLATFORM_CONFIG,
  REALTIME_TRANSPORT,
  RG_LIMITS,
  UuidSchema,
  defaultResponsibleGamingConfig,
  domainEventSchemas,
  queue,
  type JobQueueAdapter,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { ComplianceService } from './service/compliance.service.js';
import { KycVerificationService } from './service/kyc.service.js';
import { RgService } from './service/rg.service.js';
import { RgSelfServiceService } from './service/rg-self-service.service.js';
import {
  RgMonitoringService,
  RG_EVAL_TRIGGERS,
  type RgEvalTrigger,
} from './service/rg-monitoring.service.js';
import { createComplianceRouter, kycStatusChannel } from './router/index.js';
import { HmacKycWebhookVerifier } from './adapters/hmac-kyc-webhook-verifier.js';
import { RgLimitGate } from './adapters/rg-limit-gate.js';

const logger = createLogger('compliance');

const makeComplianceService = (c: TypedContainer<CoreTokenCatalog>) =>
  new ComplianceService(
    c.get(DRIZZLE),
    c.get(EVENT_BUS),
    c.has(GEO_IP_ADAPTER) ? c.get(GEO_IP_ADAPTER) : null,
  );

const RG_EVAL_QUEUE = queue('rg-eval');
const RG_MONITOR_QUEUE = queue('rg-monitor');
const KYC_DECISION_SYNC_QUEUE = queue('kyc-decision-sync');

const RgEvalJobSchema = z.object({
  userId: UuidSchema,
  trigger: z.enum(RG_EVAL_TRIGGERS),
});
const RgMonitorJobSchema = z.object({});
const KycDecisionSyncJobSchema = z.object({
  referenceId: z.string().min(1),
  status: z.enum(KYC_VENDOR_STATUSES),
  // Set only when the adapter's parseWebhook attributed the decision to one tier; absent
  // for a shared-workflow vendor session, where reconcile fans the decision across tiers.
  tier: KycTierSchema.optional(),
  // Webhook-arrival time, stamped by the router before enqueue - the monotonicity
  // watermark `reconcile` compares against, immune to job-processing reordering.
  receivedAt: z.iso.datetime(),
});

export default {
  id: 'compliance',
  dependsOn: ['player-management', 'identity', 'wallet', 'gaming', 'audit', 'exchange-rate'],
  requiresPorts: [LOGIN_ENFORCEMENT],
  register(ctx) {
    ctx.provide(GEO_CHECK_COMMANDS, makeComplianceService);
    ctx.provide(RG_LIMITS, (c) => new RgLimitGate(monitoring(c), c.get(EXCHANGE_RATE_READER)));
    ctx.provide(KYC_WEBHOOK_VERIFIER, (c) => {
      const cfg = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      const envName = cfg?.kyc?.webhookSecretEnv ?? 'KYC_WEBHOOK_SECRET';
      const webhookSecret = z
        .string()
        .min(1)
        .optional()
        .parse(process.env[envName] || undefined);
      return new HmacKycWebhookVerifier(webhookSecret, c.get(CACHE));
    });

    // svcRefs are null at registration (subscriptions wire before router factories run)
    // but set before any real event/job arrives. See create-app.ts boot order.
    let kycRef: KycVerificationService | null = null;
    let rgRef: RgService | null = null;
    let selfServiceRef: RgSelfServiceService | null = null;
    let monitorRef: RgMonitoringService | null = null;
    const monitoring = (c: TypedContainer<CoreTokenCatalog>) =>
      (monitorRef ??= new RgMonitoringService({
        drizzle: c.get(DRIZZLE),
        directory: c.has(ADMIN_USER_DIRECTORY) ? c.get(ADMIN_USER_DIRECTORY) : null,
        rates: c.get(EXCHANGE_RATE_READER),
      }));
    let jobQueueRef: JobQueueAdapter | null = null;
    let realtimeTransport: RealtimeTransport | null = null;

    ctx.events.on('compliance.kyc.updated', (payload, envelope) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      // kycStatusChannel is the basic-tier withdrawal-status stream; advanced-tier
      // updates have no consumer here yet (see tag-evaluation.service.ts's same guard).
      if (!parsed.success || !realtimeTransport || !envelope || parsed.data.tier !== 'basic') {
        return;
      }
      return realtimeTransport.publish(kycStatusChannel(parsed.data.userId), {
        eventId: envelope.eventId,
        status: parsed.data.status,
        tier: parsed.data.tier,
      });
    });

    ctx.events.on('wallet.deposit.completed', (payload) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success || !kycRef) {
        return;
      }
      kycRef
        .handleDeposit(parsed.data.userId)
        .catch((err) => logger.error({ err }, 're-KYC deposit hook failed'));
    });

    const enqueueEval = (userId: string, trigger: RgEvalTrigger) => {
      if (!jobQueueRef) {
        return;
      }
      void jobQueueRef
        .enqueue(RG_EVAL_QUEUE, { userId, trigger }, { orderingKey: userId })
        .catch((err) => logger.error({ err }, 'rg-eval enqueue failed'));
    };

    ctx.events.on('wallet.deposit.completed', (payload) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (parsed.success) {
        enqueueEval(parsed.data.userId, 'wallet.deposit.completed');
      }
    });
    ctx.events.on('gaming.round.ended', (payload) => {
      const parsed = domainEventSchemas['gaming.round.ended'].safeParse(payload);
      if (parsed.success) {
        enqueueEval(parsed.data.userId, 'gaming.round.ended');
      }
    });
    ctx.events.on('rg.exclusion.login_blocked', (payload) => {
      const parsed = domainEventSchemas['rg.exclusion.login_blocked'].safeParse(payload);
      if (parsed.success) {
        enqueueEval(parsed.data.userId, 'rg.exclusion.login_blocked');
      }
    });
    ctx.events.on('rg.limit.set', (payload) => {
      const parsed = domainEventSchemas['rg.limit.set'].safeParse(payload);
      if (parsed.success) {
        enqueueEval(parsed.data.userId, 'rg.limit.set');
      }
    });

    ctx.jobs.worker({
      queue: RG_EVAL_QUEUE,
      schema: RgEvalJobSchema,
      options: { serializeByOrderingKey: true },
      handler: async ({ payload }) => {
        if (monitorRef) {
          await monitorRef.evaluateUser(payload.userId, payload.trigger);
        }
      },
    });
    ctx.jobs.worker({
      queue: RG_MONITOR_QUEUE,
      schema: RgMonitorJobSchema,
      handler: async () => {
        if (rgRef) {
          await rgRef.expireLapsedCoolingOffs();
        }
        if (selfServiceRef) {
          await selfServiceRef.expireStaleLimitChanges();
        }
        if (monitorRef) {
          await monitorRef.sweep();
        }
      },
    });
    ctx.jobs.worker({
      queue: KYC_DECISION_SYNC_QUEUE,
      schema: KycDecisionSyncJobSchema,
      handler: async ({ payload }) => {
        if (kycRef) {
          await kycRef.syncDecision(
            payload.referenceId,
            payload.status,
            new Date(payload.receivedAt),
            payload.tier,
          );
        }
      },
    });

    ctx.routers.add('compliance', (c) => {
      realtimeTransport = c.get(REALTIME_TRANSPORT);
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      const kycAdapter = c.get(KYC_ADAPTER);
      // A KYC-gated withdrawal is meaningless while an auto-approving adapter (the default
      // MockKycAdapter) is bound: any player self-verifies and passes the gate. Fail loud -
      // refuse to boot in production, warn everywhere else.
      if (platformConfig?.kyc?.gateWithdrawals && kycAdapter.autoApproves) {
        const msg =
          'kyc.gateWithdrawals is enabled but the bound KYC_ADAPTER auto-approves (MockKycAdapter). Bind a real provider or the withdrawal gate is a no-op.';
        if (process.env['NODE_ENV'] === 'production') {
          throw new Error(msg);
        }
        logger.warn(msg);
      }
      const kyc = new KycVerificationService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        kycAdapter,
        statusWriter: c.get(KYC_STATUS_WRITER),
        identityReader: c.get(IDENTITY_READER),
        platformConfig,
      });
      kycRef = kyc;

      const rg = new RgService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        loginEnforcement: c.get(LOGIN_ENFORCEMENT),
        identityReader: c.get(IDENTITY_READER),
        // Lazy: the router factory runs after every plugin registered, so mail is bound.
        mailDispatch: c.has(MAIL_DISPATCH) ? c.get(MAIL_DISPATCH) : null,
        rates: c.get(EXCHANGE_RATE_READER),
      });
      rgRef = rg;
      const rgMonitoring = monitoring(c);
      const rgSelfService = new RgSelfServiceService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        rg,
        monitoring: rgMonitoring,
        identityReader: c.get(IDENTITY_READER),
        config: platformConfig?.responsibleGambling ?? defaultResponsibleGamingConfig,
        rates: c.get(EXCHANGE_RATE_READER),
      });
      selfServiceRef = rgSelfService;

      jobQueueRef = c.get(JOB_QUEUE);
      void jobQueueRef
        .schedule(RG_MONITOR_QUEUE, 'rg-monitor', {}, { everyMs: 60_000 })
        .catch((err) => logger.error({ err }, 'rg-monitor schedule failed'));

      return createComplianceRouter({
        compliance: makeComplianceService(c),
        adminGuard: c.get(ADMIN_GUARD),
        audit: c.get(AUDIT_WRITER),
        kyc,
        kycAdapter,
        webhookVerifier: c.get(KYC_WEBHOOK_VERIFIER),
        jobQueue: jobQueueRef,
        kycDecisionSyncQueue: KYC_DECISION_SYNC_QUEUE,
        realtime: realtimeTransport,
        rg,
        rgMonitoring,
        rgSelfService,
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
