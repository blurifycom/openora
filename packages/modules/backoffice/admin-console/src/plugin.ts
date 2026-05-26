import { definePlugin } from '@oss/plugin-host';
import { BackofficeService } from './service/backoffice.service.js';
import { BackofficeController } from './router/index.js';

export default definePlugin({
  id: 'admin-console',
  register(ctx) {
    ctx.providers.add(BackofficeService);
    ctx.controllers.add(BackofficeController);
  },
});
