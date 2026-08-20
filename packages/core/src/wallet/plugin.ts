import { ADMIN_GUARD, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  IDENTITY_READER,
  ADMIN_WALLET_REPORTING,
  PAYMENT_ADAPTER,
  PAYMENT_WEBHOOK_VERIFIER,
  PAYMENT_PROVIDERS,
  DEFAULT_PAYMENT_PROVIDER,
  WALLET_COMMANDS,
  WALLET_READER,
  WALLET_ASSET_CATALOG,
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
import { WalletAssetCatalogService } from './adapters/wallet-asset-catalog.service.js';
import { DrizzleAdminWalletReporting } from './admin-reporting.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';
import { HmacPaymentWebhookVerifier } from './adapters/hmac-payment-webhook-verifier.js';

export default {
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
    // Wraps the single PAYMENT_ADAPTER/PAYMENT_WEBHOOK_VERIFIER tokens as the 'default'
    // registry entry, so a one-vendor operator changes nothing. Core only looks a
    // providerName up here - it never discovers vendors itself, because Container.register
    // is last-wins: two overlays each rebinding the single tokens would clobber each
    // other, so running more than one vendor at once needs an operator-composed map
    // (rebind PAYMENT_PROVIDERS entirely) rather than a second core-discovered slot.
    ctx.provide(PAYMENT_PROVIDERS, (c) => ({
      get: (name: string) =>
        name === DEFAULT_PAYMENT_PROVIDER
          ? { adapter: c.get(PAYMENT_ADAPTER), webhookVerifier: c.get(PAYMENT_WEBHOOK_VERIFIER) }
          : null,
      names: () => [DEFAULT_PAYMENT_PROVIDER],
    }));
    // Other modules debit through this port within their own transaction (never importing wallet tables). See ADR-0016.
    ctx.provide(
      WALLET_COMMANDS,
      (c) =>
        new WalletCommandsService(
          c.get(PLAY_ELIGIBILITY),
          c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
        ),
    );
    // Read-only queries for cross-module consumers (eg tag evaluation). Never exposes wallet internals.
    ctx.provide(WALLET_READER, (c) => new WalletReaderService(c.get(DRIZZLE)));
    ctx.provide(ADMIN_WALLET_REPORTING, (c) => new DrizzleAdminWalletReporting(c.get(DRIZZLE)));
    // Operator-editable currency/network config, readable by a payment adapter without
    // importing wallet tables. Overlay-rebindable, but bound here so it always works.
    ctx.provide(WALLET_ASSET_CATALOG, (c) => new WalletAssetCatalogService(c.get(DRIZZLE)));
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          payment: c.get(PAYMENT_ADAPTER),
          paymentProviders: c.get(PAYMENT_PROVIDERS),
          identityReader: c.get(IDENTITY_READER),
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
        c.get(PAYMENT_PROVIDERS),
        c.get(RATE_LIMITER),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
