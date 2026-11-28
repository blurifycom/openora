import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SMS_ADAPTER, type SmsAdapter } from '@openora/core/contracts';

export default {
  id: 'testing-sms-failure',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(
      SMS_ADAPTER,
      () =>
        ({
          sendOtp: () => Promise.reject(new Error('vendor rejected: invalid sender id')),
        }) satisfies SmsAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
