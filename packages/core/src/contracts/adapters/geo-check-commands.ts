import { createToken, type Token } from './token.js';

// Who is behind a gated attempt, recorded on the audit row when the geo check blocks it.
export type GeoAccessAttempt = {
  userId?: string | null;
  userAgent?: string | null;
};

export type GeoAccessDecision = {
  allowed: boolean;
  countryCode: string | null;
};

export type GeoCheckCommands = {
  checkRegistration(
    ipAddress: string | null,
    attempt?: GeoAccessAttempt,
  ): Promise<GeoAccessDecision>;
  checkLogin(ipAddress: string | null, attempt?: GeoAccessAttempt): Promise<GeoAccessDecision>;
};

export const GEO_CHECK_COMMANDS: Token<GeoCheckCommands> = createToken('GEO_CHECK_COMMANDS');
