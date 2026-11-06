import { createToken, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export const FIXTURE_LIMITS = createToken<{ check: () => boolean }>('FIXTURE_LIMITS');

export default {
  id: 'fixture-limits',
  register(ctx) {
    ctx.provide(FIXTURE_LIMITS, () => ({ check: () => true }));
  },
} satisfies Plugin<TokenCatalog>;
