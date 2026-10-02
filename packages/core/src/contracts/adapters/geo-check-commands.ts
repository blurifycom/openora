import { createToken, type Token } from './token.js';

export type GeoCheckCommands = {
  // `redirectUrl` is the mirror origin a redirected country is admitted through, so a
  // consumer can hold such a session to that origin; null otherwise and on every denial.
  checkAccess(
    ipAddress: string | null,
  ): Promise<{ allowed: boolean; countryCode: string | null; redirectUrl: string | null }>;
};

export const GEO_CHECK_COMMANDS: Token<GeoCheckCommands> = createToken('GEO_CHECK_COMMANDS');
