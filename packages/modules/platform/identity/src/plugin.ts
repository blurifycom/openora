import { KYC_ADAPTER, NOTIFICATION_DELIVERY_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    ctx.routers.add('identity', (c) => {
      // Reset/verification emails go through the platform delivery seam (mock by
      // default; overlay swaps in SES/SendGrid). Resolved lazily so identity does
      // not depend on the notifications plugin's load order.
      const sendEmail = ({ to, subject, body }: { to: string; subject: string; body: string }) =>
        c.get(NOTIFICATION_DELIVERY_ADAPTER).sendEmail(to, subject, body);
      return createIdentityRouter(
        new IdentityService(c.get(DRIZZLE), c.get(EVENT_BUS), sendEmail),
      );
    });
  },
});
