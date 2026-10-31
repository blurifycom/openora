import { ADMIN_SECURITY_POLICY, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'identity',
  register(ctx) {
    ctx.provide(ADMIN_SECURITY_POLICY, () => ({
      assertEnrolled: async () => {},
      assertSessionIntact: async () => {},
    }));
  },
} satisfies Plugin<TokenCatalog>;
