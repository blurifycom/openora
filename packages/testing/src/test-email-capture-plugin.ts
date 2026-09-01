import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { EMAIL_SENDER } from '@openora/core/contracts';
import { captureEmail } from './captured-emails.js';

export default {
  id: 'testing-email-capture',
  dependsOn: ['mail'],
  register(ctx) {
    ctx.provide(EMAIL_SENDER, () => ({
      async send({ to, subject, html, text }) {
        captureEmail({ to, subject, html, text });
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
