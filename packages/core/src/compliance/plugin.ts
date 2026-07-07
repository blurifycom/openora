import {
  definePlugin,
  EVENT_BUS,
  DRIZZLE,
  ADMIN_GUARD,
  createLogger,
} from '@blurifycom/core/server';
import {
  GEO_IP_ADAPTER,
  KYC_ADAPTER,
  KYC_STATUS_WRITER,
  KYC_WEBHOOK_VERIFIER,
  PLATFORM_CONFIG,
  domainEventSchemas,
} from '@blurifycom/core/contracts';
import { ComplianceService } from './service/compliance.service.js';
import { KycVerificationService } from './service/kyc.service.js';
import { createComplianceRouter } from './router/index.js';
import { HmacKycWebhookVerifier } from './adapters/hmac-kyc-webhook-verifier.js';

const logger = createLogger('compliance');

// dependsOn pins the KYC_STATUS_WRITER (player-management) + KYC_ADAPTER (identity)
// providers ahead of compliance for a SERVICE_MANIFEST split. See ADR-0017.
export default definePlugin({
  id: 'compliance',
  dependsOn: ['player-management', 'identity'],
  register(ctx) {
    ctx.provide(KYC_WEBHOOK_VERIFIER, (c) => {
      const cfg = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      const envName = cfg?.kyc?.webhookSecretEnv ?? 'KYC_WEBHOOK_SECRET';
      return new HmacKycWebhookVerifier(process.env[envName]);
    });

    // Threshold re-KYC reacts to deposits. svcRef is null at registration (subscriptions
    // wire before router factories run) but set before any real event arrives.
    let kycRef: KycVerificationService | null = null;
    ctx.events.on('wallet.deposit.completed', (payload) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success || !kycRef) return;
      kycRef
        .handleDeposit(parsed.data.userId)
        .catch((err) => logger.error({ err }, 're-KYC deposit hook failed'));
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
        if (process.env['NODE_ENV'] === 'production') throw new Error(msg);
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
      });
    });
  },
});
