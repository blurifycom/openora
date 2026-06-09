import { definePlugin } from '@oss/plugin-host';
import { PAYMENT_ADAPTER, WALLET_COMMANDS } from '@oss/adapters';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { WalletService } from './service/wallet.service.js';
import { WalletCommandsService } from './service/wallet-commands.service.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    // Wallet owns money mutation: other modules debit through this port (within
    // their own transaction) instead of importing wallet's tables. See ADR-0016.
    ctx.provide(WALLET_COMMANDS, () => new WalletCommandsService());
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER)),
      ),
    );
  },
});
