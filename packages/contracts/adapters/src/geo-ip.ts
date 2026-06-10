// Geo-IP seam. A vendor (eg MaxMind) implements GeoIpAdapter; bind a concrete
// adapter to GEO_IP_ADAPTER in the compliance module's plugin.ts.
import { createToken, type Token } from './token.js';

export type GeoIpAdapter = {
  lookup(ipAddress: string): Promise<{ countryCode: string | null }>;
};

export const GEO_IP_ADAPTER: Token<GeoIpAdapter> = createToken('GEO_IP_ADAPTER');
