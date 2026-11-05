import { ADMIN_PERMISSION_RESOLVER, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'iam',
  register(ctx) {
    ctx.provide(ADMIN_PERMISSION_RESOLVER, () => ({
      getGrants: async () => [],
      isSuperAdmin: async () => false,
    }));
  },
} satisfies Plugin<TokenCatalog>;
