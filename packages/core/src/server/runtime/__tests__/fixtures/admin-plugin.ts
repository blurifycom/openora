import type { TokenCatalog } from '@openora/core/contracts';
import { ADMIN_GUARD } from '../../../auth/index.js';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

// Resolves the guard in its router factory, as every module with admin routes does.
export default {
  id: 'fixture-admin',
  register(ctx) {
    ctx.routers.add('fixture-admin', (c) => {
      c.get(ADMIN_GUARD);
      return {};
    });
  },
} satisfies Plugin<TokenCatalog>;
