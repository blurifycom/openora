/**
 * Identity options token. Downstream operators can provide this to configure
 * identity behaviors such as login rate-limiting/lockouts.
 */
import { createToken, type Token } from './token.js';

export type IdentityLockoutOptions = {
  enabled?: boolean;
  maxAttempts?: number;
  durationMs?: number;
  bypassForAdmins?: boolean;
};

export type IdentityServiceOptions = {
  lockout?: IdentityLockoutOptions;
};

export const IDENTITY_OPTIONS: Token<IdentityServiceOptions> =
  createToken<IdentityServiceOptions>('IDENTITY_OPTIONS');

export type SessionCommands = {
  revokeAll(userId: string, actorId?: string): Promise<{ success: boolean }>;
};

export const SESSION_COMMANDS: Token<SessionCommands> =
  createToken<SessionCommands>('SESSION_COMMANDS');
