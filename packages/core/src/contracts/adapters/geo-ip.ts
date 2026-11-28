import { CountryCodeSchema } from '../schemas/igaming-config.js';
import { createToken, type Token } from './token.js';

export type GeoIpAdapter = {
  lookup(ipAddress: string): Promise<{ countryCode: string | null }>;
};

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = CountryCodeSchema.safeParse(value.trim().toUpperCase());
  return parsed.success ? parsed.data : null;
}

export const GEO_IP_ADAPTER: Token<GeoIpAdapter> = createToken('GEO_IP_ADAPTER');
