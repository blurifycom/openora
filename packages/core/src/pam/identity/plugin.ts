import {
  ADMIN_USER_DIRECTORY,
  KYC_ADAPTER,
  NOTIFICATION_DELIVERY_ADAPTER,
  SEND_EMAIL,
  IDENTITY_OPTIONS,
} from '@blurifycom/core/contracts';
import { definePlugin, ADMIN_GUARD, EVENT_BUS, DRIZZLE } from '@blurifycom/core/server';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { DrizzleAdminUserDirectory } from './admin-user-directory.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';
import { SessionService } from './service/session.service.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    // The back-office depends on this port, not on the identity schema directly.
    ctx.provide(
      ADMIN_USER_DIRECTORY,
      (c) => new DrizzleAdminUserDirectory(c.get(DRIZZLE), c.get(EVENT_BUS)),
    );
    // Resolved lazily so identity does not depend on the notifications plugin's load order.
    ctx.provide(SEND_EMAIL, (c) => ({
      send: ({ to, subject, body }) =>
        c.get(NOTIFICATION_DELIVERY_ADAPTER).sendEmail(to, subject, body),
    }));
    ctx.routers.add('identity', (c) =>
      createIdentityRouter(
        new IdentityService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          email: c.get(SEND_EMAIL),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
        }),
        new SessionService({ drizzle: c.get(DRIZZLE), events: c.get(EVENT_BUS) }),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
