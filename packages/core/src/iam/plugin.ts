import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@blurifycom/core/server';
import { ADMIN_PERMISSION_RESOLVER, SEND_EMAIL } from '@blurifycom/core/contracts';
import { IamService, DbAdminPermissionResolver } from './service/iam.service.js';
import { createIamRouter } from './router/index.js';

export default definePlugin({
  id: 'iam',
  dependsOn: ['identity'],
  register(ctx) {
    // Tenant is resolved per request inside getGrants(), never captured at boot
    // (factories run once outside any request ALS frame).
    ctx.provide(ADMIN_PERMISSION_RESOLVER, (c) => new DbAdminPermissionResolver(c.get(DRIZZLE)));

    ctx.routers.add('iam', (c) =>
      createIamRouter(
        new IamService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(SEND_EMAIL)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
