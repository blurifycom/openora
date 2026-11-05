import { createToken, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export const FIXTURE_DISPATCH = createToken<{ send: () => void }>('FIXTURE_DISPATCH');

export default {
  id: 'fixture-dispatch',
  dependsOn: ['fixture-leaf'],
  register(ctx) {
    ctx.provide(FIXTURE_DISPATCH, () => ({ send: () => {} }));
  },
} satisfies Plugin<TokenCatalog>;
