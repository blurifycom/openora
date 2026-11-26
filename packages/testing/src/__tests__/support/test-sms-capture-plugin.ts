import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SMS_ADAPTER } from '@openora/core/contracts';

const sent: { to: string; code: string }[] = [];

export const smsCodesFor = (to: string) =>
  sent
    .filter((message) => message.to === to)
    .map((message) => message.code)
    .reverse();

export default {
  id: 'testing-sms-capture',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(SMS_ADAPTER, () => ({
      async sendOtp({ to, code }) {
        sent.push({ to, code });
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
