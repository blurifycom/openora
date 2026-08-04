import {
  definePlugin,
  ADMIN_GUARD,
  EVENT_BUS,
  DRIZZLE,
  CORE_TOKEN_CATALOG,
} from '@openora/core/server';
import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  ADMIN_WALLET_REPORTING,
  PAYMENT_ADAPTER,
  PAYMENT_WEBHOOK_VERIFIER,
  WALLET_COMMANDS,
  WALLET_READER,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  PLAYER_TAGS,
  TAG_EVALUATION_COMMANDS,
  PLAY_ELIGIBILITY,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { WalletService } from './service/wallet.service.js';
import { WalletCommandsService } from './service/wallet-commands.service.js';
import { WalletReaderService } from './adapters/wallet-reader.service.js';
import { DrizzleAdminWalletReporting } from './admin-reporting.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';
import { HmacPaymentWebhookVerifier } from './adapters/hmac-payment-webhook-verifier.js';

export default definePlugin(CORE_TOKEN_CATALOG, {
  // NOT dependsOn 'tag': that would cycle (tag hard-depends on wallet's WALLET_READER).
  // wallet's use of tag's PLAYER_TAGS / TAG_EVALUATION_COMMANDS is optional and resolved
  // lazily in the router factory (`c.has(...)`), which runs after every plugin has
  // registered - so both ports are bound by then regardless of load order.
  id: 'wallet',
  dependsOn: ['identity', 'audit'],
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    ctx.provide(PAYMENT_WEBHOOK_VERIFIER, () => {
      const webhookSecret = z
        .string()
        .min(1)
        .optional()
        .parse(process.env.PAYMENT_WEBHOOK_SECRET || undefined);
      return new HmacPaymentWebhookVerifier(webhookSecret);
    });
    // Other modules debit through this port within their own transaction (never importing wallet tables). See ADR-0016.
    ctx.provide(WALLET_COMMANDS, (c) => new WalletCommandsService(c.get(PLAY_ELIGIBILITY)));
    // Read-only queries for cross-module consumers (eg tag evaluation). Never exposes wallet internals.
    ctx.provide(WALLET_READER, (c) => new WalletReaderService(c.get(DRIZZLE)));
    ctx.provide(ADMIN_WALLET_REPORTING, (c) => new DrizzleAdminWalletReporting(c.get(DRIZZLE)));
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          payment: c.get(PAYMENT_ADAPTER),
          directory: c.get(ADMIN_USER_DIRECTORY),
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          limiter: c.get(RATE_LIMITER),
          riskTags: c.has(PLAYER_TAGS) ? c.get(PLAYER_TAGS) : undefined,
          tagEvaluationCommands: c.has(TAG_EVALUATION_COMMANDS)
            ? c.get(TAG_EVALUATION_COMMANDS)
            : undefined,
          audit: c.get(AUDIT_WRITER),
        }),
        c.get(ADMIN_GUARD),
        c.get(AUDIT_WRITER),
        c.get(PAYMENT_ADAPTER),
        c.get(PAYMENT_WEBHOOK_VERIFIER),
      ),
    );
  },
});
