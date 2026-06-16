import { ADMIN_USER_DIRECTORY, ADMIN_WALLET_REPORTING } from '@oss/core/contracts';
import { definePlugin } from '@oss/core/server';
import { ADMIN_GUARD } from '@oss/core/server';
import { BackofficeService } from './service/backoffice.service.js';
import { createBackofficeRouter } from './router/index.js';

export default definePlugin({
  id: 'admin-console',
  // The directory + reporting ports are bound by identity + wallet; load after them.
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
