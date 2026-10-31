import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'fixture-leaf',
  dependsOn: ['fixture-feature'],
  register() {},
} satisfies Plugin<TokenCatalog>;
