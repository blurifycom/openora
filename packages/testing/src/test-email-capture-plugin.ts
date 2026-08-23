import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { NOTIFICATION_DELIVERY_ADAPTER } from '@openora/core/contracts';
import { captureEmail } from './captured-emails.js';

export default {
  id: 'testing-email-capture',
  dependsOn: ['notifications'],
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => ({
      async sendEmail(to: string, subject: string, body: string) {
        captureEmail({ to, subject, body });
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
