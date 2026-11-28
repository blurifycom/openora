import { createToken, type Token } from './token.js';

export type IdentityLockoutOptions = {
  enabled?: boolean;
  maxAttempts?: number;
  durationMs?: number;
  bypassForAdmins?: boolean;
};

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

export type UserCommands = {
  setUsername(userId: string, username: string, tx?: unknown): Promise<{ success: boolean }>;
  createAdmin(
    input: { email: string; name: string; password: string },
    tx?: unknown,
  ): Promise<{ id: string }>;
  publishPlayEligibility(userId: string, tx: unknown): Promise<void>;
};

export const USER_COMMANDS: Token<UserCommands> = createToken<UserCommands>('USER_COMMANDS');
