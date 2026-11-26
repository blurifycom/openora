import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { IGAMING_CONFIG, defineIgamingConfig } from '@openora/core/contracts';

export const LICENSED_JURISDICTION = 'MT';

export default {
  id: 'testing-geo-licensed',
  dependsOn: ['compliance'],
  register(ctx) {
    ctx.provide(IGAMING_CONFIG, () =>
      defineIgamingConfig({
        branding: { name: 'Geo E2E' },
        currencies: ['USD'],
        jurisdictions: [LICENSED_JURISDICTION],
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
