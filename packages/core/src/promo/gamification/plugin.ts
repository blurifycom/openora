import type { CoreTokenCatalog, Plugin } from '@openora/core/server';

export default {
  id: 'gamification',
  register() {},
} as const satisfies Plugin<CoreTokenCatalog>;
