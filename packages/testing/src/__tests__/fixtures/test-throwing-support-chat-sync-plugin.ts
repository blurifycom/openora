import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SUPPORT_CHAT_PROVIDER, type SupportChatProvider } from '@openora/core/contracts';

// A support-chat vendor whose token calls work and whose context writes always fail. The count is
// on the process because the app loads this file as a separate module instance from the test.
const ATTEMPTS = Symbol.for('openora.testing.support-chat-throwing-sync');
const holder = globalThis as typeof globalThis & { [ATTEMPTS]?: number };

export const failedSupportChatSyncAttempts = () => holder[ATTEMPTS] ?? 0;

export default {
  id: 'test-throwing-support-chat-sync',
  dependsOn: ['support-chat'],
  register(ctx) {
    ctx.provide(
      SUPPORT_CHAT_PROVIDER,
      () =>
        ({
          async issueCustomerToken(input) {
            return {
              customerId: input.customerId ?? `customer-${randomUUID()}`,
              accessToken: `token-${randomUUID()}`,
              tokenType: 'Bearer',
              expiresInMs: 3_600_000,
            };
          },
          async syncCustomer() {
            holder[ATTEMPTS] = (holder[ATTEMPTS] ?? 0) + 1;
            throw new Error('vendor write failed');
          },
        }) satisfies SupportChatProvider,
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
