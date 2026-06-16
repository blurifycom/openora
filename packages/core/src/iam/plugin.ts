import { definePlugin } from '@oss/core/server';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { ADMIN_GUARD } from '@oss/core/server';
import { ADMIN_PERMISSION_RESOLVER, SEND_EMAIL } from '@oss/core/contracts';
import { IamService, DbAdminPermissionResolver } from './service/iam.service.js';
import { createIamRouter } from './router/index.js';

export default definePlugin({
  id: 'iam',
  dependsOn: ['identity'],
  register(ctx) {
    // Bind the DB-backed permission resolver. AdminGuard picks it up and stops
    // falling back to static roles for users that have a DB role assignment.
    // The tenant is resolved per request INSIDE getGrants(), never captured here -
    // factories run once at boot outside any request ALS frame.
    ctx.provide(ADMIN_PERMISSION_RESOLVER, (c) => new DbAdminPermissionResolver(c.get(DRIZZLE)));

    ctx.routers.add('iam', (c) =>
      createIamRouter(
        new IamService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(SEND_EMAIL)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
