import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { GEO_IP_ADAPTER } from '@openora/core/contracts';

/**
 * Resolves a country straight from the caller's address, so an e2e can drive a
 * blocked country, an allowed country and an unresolvable address through the real
 * country-rule path without a vendor database.
 */
export const GEO_IP_FIXTURE: Record<string, string> = {
  '203.0.113.10': 'DE',
  '203.0.113.20': 'PL',
};

export default {
  id: 'testing-geo-ip',
  dependsOn: ['compliance'],
  register(ctx) {
    ctx.provide(GEO_IP_ADAPTER, () => ({
      lookup: async (ipAddress: string) => ({ countryCode: GEO_IP_FIXTURE[ipAddress] ?? null }),
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
