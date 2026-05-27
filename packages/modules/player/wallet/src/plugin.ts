import { definePlugin } from '@oss/plugin-host';
import { PAYMENT_ADAPTER } from '@oss/adapters';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { WalletService } from './service/wallet.service.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER))),
    );
  },
});
