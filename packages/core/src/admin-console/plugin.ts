import { ADMIN_USER_DIRECTORY, ADMIN_WALLET_REPORTING } from '@blurifycom/core/contracts';
import { definePlugin } from '@blurifycom/core/server';
import { ADMIN_GUARD } from '@blurifycom/core/server';
import { BackofficeService } from './service/backoffice.service.js';
import { createBackofficeRouter } from './router/index.js';

export default definePlugin({
  id: 'admin-console',
  dependsOn: ['identity', 'wallet'],
  register(ctx) {
    ctx.routers.add('backoffice', (c) =>
      createBackofficeRouter(
        new BackofficeService(c.get(ADMIN_USER_DIRECTORY), c.get(ADMIN_WALLET_REPORTING)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
