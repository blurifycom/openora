import { definePlugin } from '@oss/plugin-host';
import { WalletService } from './service/wallet.service.js';
import { WalletController } from './router/index.js';

export default definePlugin({
  id: 'wallet',
  register(ctx) {
    ctx.providers.add(WalletService);
    ctx.controllers.add(WalletController);
  },
});
