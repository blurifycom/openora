import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { GEO_IP_ADAPTER } from '@openora/core/contracts';

export default {
  id: 'testing-geo-ip-failing',
  dependsOn: ['compliance'],
  register(ctx) {
    ctx.provide(GEO_IP_ADAPTER, () => ({
      lookup: async () => {
        throw new Error('geo provider unavailable');
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
