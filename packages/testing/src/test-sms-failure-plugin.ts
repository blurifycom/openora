import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SMS_ADAPTER, type SmsAdapter } from '@openora/core/contracts';

/**
 * Overrides SMS_ADAPTER with one that always rejects, so a test can prove a vendor
 * failure surfaces to the caller instead of being swallowed. Opt-in only (unlike
 * `test-email-capture-plugin.ts`, `bootTestApp` never registers this on its own) -
 * pass it in `config.plugins` for the one test that wants a failing transport.
 */
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
