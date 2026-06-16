import { definePlugin } from '@oss/core/server';
import { ADMIN_WALLET_REPORTING, PAYMENT_ADAPTER, WALLET_COMMANDS } from '@oss/core/contracts';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { WalletService } from './service/wallet.service.js';
import { WalletCommandsService } from './service/wallet-commands.service.js';
import { DrizzleAdminWalletReporting } from './admin-reporting.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    // Wallet owns money mutation: other modules debit through this port (within
    // their own transaction) instead of importing wallet's tables. See ADR-0016.
    ctx.provide(WALLET_COMMANDS, () => new WalletCommandsService());
    // Admin/back-office reporting over money movement - the back-office depends on
    // this port, not on the wallet schema.
    ctx.provide(ADMIN_WALLET_REPORTING, (c) => new DrizzleAdminWalletReporting(c.get(DRIZZLE)));
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER)),
      ),
    );
  },
});
