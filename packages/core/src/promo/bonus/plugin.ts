import type { CoreTokenCatalog, Plugin } from '@openora/core/server';

// DI wiring only - no business logic here. The bonus engine binds its command ports here
// once they have implementations; today the module owns the wagering weight tables and the
// resolution the engine will call, and exposes no route yet.
export default {
  id: 'bonus',
  register() {},
} as const satisfies Plugin<CoreTokenCatalog>;
