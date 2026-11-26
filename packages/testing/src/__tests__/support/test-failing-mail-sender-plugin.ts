import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { EMAIL_SENDER } from '@openora/core/contracts';
import { captureEmail } from '../../captured-emails.js';

const failing = new Set<string>();
const attempts = new Map<string, number>();

export class MailDeliveryRefusedError extends Error {
  override name = 'MailDeliveryRefusedError';
}

export const failSendsTo = (address: string) => {
  failing.add(address.toLowerCase());
};

export const sendAttemptsTo = (address: string) => attempts.get(address.toLowerCase()) ?? 0;

export default {
  id: 'testing-failing-mail-sender',
  dependsOn: ['mail'],
  register(ctx) {
    ctx.provide(EMAIL_SENDER, () => ({
      async send({ to, subject, html, text }) {
        const key = to.toLowerCase();
        if (failing.has(key)) {
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          throw new MailDeliveryRefusedError('provider refused the message');
        }
        captureEmail({ to, subject, html, text });
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
