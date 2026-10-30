import { createToken, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../define-plugin.js';

export const PORTED = createToken<string>('ported');

export default {
  id: 'ported',
  register(ctx) {
    ctx.provide(PORTED, () => 'bound');
    ctx.routers.add('ported', () => ({}));
  },
} as const satisfies Plugin<TokenCatalog>;
