// Identity options token. Downstream operators can provide this to configure
// identity behaviors such as login rate-limiting/lockouts.
import { createToken, type Token } from './token.js';

export type IdentityLockoutOptions = {
  enabled: boolean;
  maxAttempts?: number;
  durationMs?: number;
};

export type IdentityServiceOptions = {
  lockout?: IdentityLockoutOptions;
};

export const IDENTITY_OPTIONS: Token<IdentityServiceOptions> =
  createToken<IdentityServiceOptions>('IDENTITY_OPTIONS');
