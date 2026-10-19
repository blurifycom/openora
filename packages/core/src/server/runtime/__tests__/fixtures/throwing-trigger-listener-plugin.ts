import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'throwing-trigger-listener',
  register(ctx) {
    ctx.triggers.listen(() => {
      throw new Error('listener failed');
    });
  },
} satisfies Plugin<TokenCatalog>;
