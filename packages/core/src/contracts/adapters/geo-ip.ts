/**
 * Geo-IP seam. A vendor (eg MaxMind) implements GeoIpAdapter; bind a concrete
 * adapter to GEO_IP_ADAPTER in the compliance module's plugin.ts.
 */
import { CountryCodeSchema } from '../schemas/igaming-config.js';
import { createToken, type Token } from './token.js';

export type GeoIpAdapter = {
  lookup(ipAddress: string): Promise<{ countryCode: string | null }>;
};

/** Normalize an adapter value to a validated ISO country code. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = CountryCodeSchema.safeParse(value.trim().toUpperCase());
  return parsed.success ? parsed.data : null;
}

export const GEO_IP_ADAPTER: Token<GeoIpAdapter> = createToken('GEO_IP_ADAPTER');
