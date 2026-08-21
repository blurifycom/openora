import { createToken, type Token } from './token.js';

export type GeoCheckCommands = {
  checkRegistration(ipAddress: string | null): Promise<{ allowed: boolean }>;
};

export const GEO_CHECK_COMMANDS: Token<GeoCheckCommands> = createToken('GEO_CHECK_COMMANDS');
