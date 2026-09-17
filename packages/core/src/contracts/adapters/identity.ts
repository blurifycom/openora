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

/**
 * Coarse per-IP throttle on login attempts, separate from the per-account lockout
 * above. Protects against credential stuffing across many accounts from one source
 * (eg a botnet or a leaked-credential list), which the per-account counter can't see
 * because each guess lands on a different account. Must stay well above the
 * per-account threshold so a shared network (office NAT) never blocks legitimate
 * users signing into their own accounts.
 */
export type IdentityLoginIpRateLimitOptions = {
  enabled?: boolean;
  limit?: number;
  windowMs?: number;
};

export type IdentityServiceOptions = {
  lockout?: IdentityLockoutOptions;
  loginIpRateLimit?: IdentityLoginIpRateLimitOptions;
};

export const IDENTITY_OPTIONS: Token<IdentityServiceOptions> =
  createToken<IdentityServiceOptions>('IDENTITY_OPTIONS');

export type SessionCommands = {
  revokeAll(userId: string, actorId?: string): Promise<{ success: boolean }>;
};

export const SESSION_COMMANDS: Token<SessionCommands> =
  createToken<SessionCommands>('SESSION_COMMANDS');

/**
 * Writes to identity-owned user columns. Sibling modules may read `user` through the
 * `/schema` subpath but must mutate it here, so identity keeps its own invariants.
 */
export type UserCommands = {
  /** Throws if the handle is taken; comparison is case-insensitive. */
  setUsername(userId: string, username: string): Promise<{ success: boolean }>;
};

export const USER_COMMANDS: Token<UserCommands> = createToken<UserCommands>('USER_COMMANDS');
