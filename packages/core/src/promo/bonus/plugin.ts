import type { CoreTokenCatalog, Plugin } from '@openora/core/server';

export default {
  id: 'bonus',
  register() {},
} as const satisfies Plugin<CoreTokenCatalog>;
