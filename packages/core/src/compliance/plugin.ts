import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  GEO_IP_ADAPTER,
  JOB_QUEUE,
  KYC_ADAPTER,
  KYC_STATUS_WRITER,
  KYC_WEBHOOK_VERIFIER,
  LOGIN_ENFORCEMENT,
  PLATFORM_CONFIG,
  SEND_EMAIL,
  EMAIL_TEMPLATE_RENDERER,
  UuidSchema,
  domainEventSchemas,
  queue,
  type JobQueueAdapter,
} from '@openora/core/contracts';
import { ComplianceService } from './service/compliance.service.js';
import { KycVerificationService } from './service/kyc.service.js';
import { RgService } from './service/rg.service.js';
import {
  RgMonitoringService,
  RG_EVAL_TRIGGERS,
  type RgEvalTrigger,
} from './service/rg-monitoring.service.js';
import { createComplianceRouter } from './router/index.js';
import { HmacKycWebhookVerifier } from './adapters/hmac-kyc-webhook-verifier.js';

const logger = createLogger('compliance');

const RG_EVAL_QUEUE = queue('rg-eval');
const RG_MONITOR_QUEUE = queue('rg-monitor');

const RgEvalJobSchema = z.object({
  userId: UuidSchema,
  trigger: z.enum(RG_EVAL_TRIGGERS),
});
const RgMonitorJobSchema = z.object({});

export default definePlugin({
  id: 'compliance',
  dependsOn: ['player-management', 'identity', 'wallet', 'gaming'],
  requiresPorts: [LOGIN_ENFORCEMENT],
  register(ctx) {
    ctx.provide(KYC_WEBHOOK_VERIFIER, (c) => {
      const cfg = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      const envName = cfg?.kyc?.webhookSecretEnv ?? 'KYC_WEBHOOK_SECRET';
      const webhookSecret = z
        .string()
        .min(1)
        .optional()
        .parse(process.env[envName] || undefined);
      return new HmacKycWebhookVerifier(webhookSecret);
    });

    // svcRefs are null at registration (subscriptions wire before router factories run)
    // but set before any real event/job arrives. See create-app.ts boot order.
    let kycRef: KycVerificationService | null = null;
    let rgRef: RgService | null = null;
    let monitorRef: RgMonitoringService | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;

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
        .enqueue(
          RG_EVAL_QUEUE,
          { userId, trigger },
          { idempotencyKey: `rg-eval:${userId}`, orderingKey: userId },
        )
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
        if (monitorRef) {
          await monitorRef.sweep();
        }
      },
    });

    ctx.routers.add('compliance', (c) => {
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
        platformConfig,
      });
      kycRef = kyc;

      const directory = c.has(ADMIN_USER_DIRECTORY) ? c.get(ADMIN_USER_DIRECTORY) : null;
      const rg = new RgService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        loginEnforcement: c.get(LOGIN_ENFORCEMENT),
        email: c.has(SEND_EMAIL) ? c.get(SEND_EMAIL) : null,
        directory,
        templateRenderer: c.has(EMAIL_TEMPLATE_RENDERER) ? c.get(EMAIL_TEMPLATE_RENDERER) : null,
      });
      rgRef = rg;
      const rgMonitoring = new RgMonitoringService({ drizzle: c.get(DRIZZLE), directory });
      monitorRef = rgMonitoring;

      jobQueueRef = c.get(JOB_QUEUE);
      void jobQueueRef
        .schedule(RG_MONITOR_QUEUE, 'rg-monitor', {}, { everyMs: 60_000 })
        .catch((err) => logger.error({ err }, 'rg-monitor schedule failed'));

      return createComplianceRouter({
        compliance: new ComplianceService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.has(GEO_IP_ADAPTER) ? c.get(GEO_IP_ADAPTER) : null,
        ),
        adminGuard: c.get(ADMIN_GUARD),
        kyc,
        kycAdapter,
        webhookVerifier: c.get(KYC_WEBHOOK_VERIFIER),
        rg,
        rgMonitoring,
      });
    });
  },
});
