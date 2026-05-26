// Geo-IP seam. A vendor (eg MaxMind) implements GeoIpAdapter; bind a concrete
// adapter to GEO_IP_ADAPTER in the compliance module's plugin.ts.

export interface GeoIpAdapter {
  lookup(ipAddress: string): Promise<{ countryCode: string | null }>;
}

export const GEO_IP_ADAPTER = Symbol('GEO_IP_ADAPTER');
