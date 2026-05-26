import { definePlugin } from '@oss/plugin-host';
import { PAYMENT_ADAPTER } from '@oss/adapters';
import { WalletService } from './service/wallet.service.js';
import { WalletController } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  register(ctx) {
    ctx.providers.add({
      provide: PAYMENT_ADAPTER,
      useClass: MockPaymentAdapter,
    });
    ctx.providers.add(WalletService);
    ctx.controllers.add(WalletController);
  },
});
