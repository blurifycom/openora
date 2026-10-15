import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { CHAT_CONTEXT_SEND_POLICY } from '@openora/core/contracts';

export const DENIED_CONTEXT_REF_PREFIX = 'ctx-denied:';

export default {
  id: 'test-chat-context-send-policy',
  dependsOn: ['chat'],
  register(ctx) {
    ctx.provide(CHAT_CONTEXT_SEND_POLICY, () => ({
      check: async ({ contextRef }) =>
        contextRef.startsWith(DENIED_CONTEXT_REF_PREFIX)
          ? { allowed: false, reason: 'recipient_privacy' }
          : { allowed: true },
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
