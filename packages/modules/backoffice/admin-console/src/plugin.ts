import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { BackofficeService } from './service/backoffice.service.js';
import { createBackofficeRouter } from './router/index.js';

export default definePlugin({
  id: 'admin-console',
  register(ctx) {
    ctx.routers.add('backoffice', (c) =>
      createBackofficeRouter(new BackofficeService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
  },
});
