import { definePlugin } from '@blurifycom/core/server';
import {
  ADMIN_USER_DIRECTORY,
  ADMIN_WALLET_REPORTING,
  PAYMENT_ADAPTER,
  WALLET_COMMANDS,
} from '@blurifycom/core/contracts';
import { ADMIN_GUARD, EVENT_BUS } from '@blurifycom/core/server';
import { DRIZZLE } from '@blurifycom/core/server';
import { WalletService } from './service/wallet.service.js';
import { WalletCommandsService } from './service/wallet-commands.service.js';
import { DrizzleAdminWalletReporting } from './admin-reporting.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  // The withdrawal queue resolves ADMIN_USER_DIRECTORY (owned by identity) to enrich
  // items with player username/kycStatus; pin load order so a SERVICE_MANIFEST=wallet
  // split still finds the port. See ADR-0017.
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    // Other modules debit through this port within their own transaction (never importing wallet tables). See ADR-0016.
    ctx.provide(WALLET_COMMANDS, () => new WalletCommandsService());
    ctx.provide(ADMIN_WALLET_REPORTING, (c) => new DrizzleAdminWalletReporting(c.get(DRIZZLE)));
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(PAYMENT_ADAPTER),
          c.get(ADMIN_USER_DIRECTORY),
        ),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
