import { createToken, type Token } from './token.js';

/**
 * Synchronous registration-time geo policy. Identity consumes this optional
 * command port so it never imports the compliance module or creates a plugin
 * dependency cycle.
 */
export type GeoCheckCommands = {
  checkRegistration(ipAddress: string | null): Promise<{ allowed: boolean }>;
};

export const GEO_CHECK_COMMANDS: Token<GeoCheckCommands> = createToken('GEO_CHECK_COMMANDS');
