import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { GEO_IP_ADAPTER, type GeoIpAdapter } from '@openora/core/contracts';

class FixedCountryGeoIpAdapter implements GeoIpAdapter {
  async lookup(_ipAddress: string): Promise<{ countryCode: string }> {
    return { countryCode: 'US' };
  }
}

/** Deterministic country lookup for the per-game geo-blocking E2E flow. */
export default {
  id: 'test-game-geo-ip',
  register(ctx) {
    ctx.provide(GEO_IP_ADAPTER, () => new FixedCountryGeoIpAdapter());
  },
} as const satisfies Plugin<CoreTokenCatalog>;
