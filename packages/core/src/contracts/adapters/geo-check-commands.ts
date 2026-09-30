import { createToken, type Token } from './token.js';

export type GeoCheckCommands = {
  checkAccess(ipAddress: string | null): Promise<{ allowed: boolean; countryCode: string | null }>;
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
