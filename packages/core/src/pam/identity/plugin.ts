import {
  ADMIN_USER_DIRECTORY,
  KYC_ADAPTER,
  NOTIFICATION_DELIVERY_ADAPTER,
  SEND_EMAIL,
} from '@oss/core/contracts';
import type { SendEmailPort } from '@oss/core/contracts';
import { definePlugin } from '@oss/core/server';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { DrizzleAdminUserDirectory } from './admin-user-directory.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    // Admin/back-office view of the user directory (read + role/active write).
    // The back-office depends on this port, not on the identity schema.
    ctx.provide(ADMIN_USER_DIRECTORY, (c) => new DrizzleAdminUserDirectory(c.get(DRIZZLE)));
    // Reset/verification emails go through the platform delivery seam (mock by
    // default; overlay swaps in SES/SendGrid). Resolved lazily so identity does
    // not depend on the notifications plugin's load order.
    ctx.provide(
      SEND_EMAIL,
      (c): SendEmailPort => ({
        send: ({ to, subject, body }) =>
          c.get(NOTIFICATION_DELIVERY_ADAPTER).sendEmail(to, subject, body),
      }),
    );
    ctx.routers.add('identity', (c) =>
      createIdentityRouter(
        new IdentityService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(SEND_EMAIL)),
      ),
    );
  },
});
