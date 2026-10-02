import { createToken, type Token } from './token.js';

export type GeoCheckCommands = {
  // `redirectUrl` is the mirror origin a redirected country is admitted through, so a
  // consumer can hold such a session to that origin; null otherwise and on every denial.
  checkAccess(
    ipAddress: string | null,
  ): Promise<{ allowed: boolean; countryCode: string | null; redirectUrl: string | null }>;
  /**
   * The same decision for a surface a visitor browses rather than an enforcement point: a
   * denial is audited once per address and country per window, not on every request. Optional
   * so an existing rebind keeps compiling; a caller falls back to `checkAccess`.
   */
  visitorGeoCheck?(
    ipAddress: string | null,
  ): Promise<{ allowed: boolean; countryCode: string | null }>;
};

export const GEO_CHECK_COMMANDS: Token<GeoCheckCommands> = createToken('GEO_CHECK_COMMANDS');
