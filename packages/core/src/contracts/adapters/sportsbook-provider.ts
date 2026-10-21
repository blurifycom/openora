/**
 * Sportsbook provider port: the outbound half of the provider bridge, bound by the operator's
 * overlay. Core calls it only outside a transaction. Core ships no default binding: with none,
 * session issue refuses and reconciliation files findings instead of resolving bets.
 */
import type { SportsbookProviderBetStatus } from '../schemas/sportsbook.js';
import { createToken, type Token } from './token.js';

export type SportsbookProviderSessionArgs = {
  /** The opaque reference the provider presents back on every callback. */
  sessionId: string;
  userId: string;
  currency: string;
  countryCode: string;
  expiresAt: string;
  /** The player's language tag, as on `user.language`, when the client sent one. */
  locale?: string;
};

export type SportsbookProviderSession = {
  /** What the client hands the provider's widget. Never stored by core. */
  token: string;
  launchUrl?: string;
};

export type SportsbookProvider = {
  /** The provider key every ledger call for this provider carries. */
  name: string;
  issueSession(args: SportsbookProviderSessionArgs): Promise<SportsbookProviderSession>;
  /** Resolves for a session the provider never opened or already closed; a throw is retried. */
  revokeSession?(args: { sessionId: string; userId: string }): Promise<void>;
  getBetStatus(args: { providerBetId: string }): Promise<SportsbookProviderBetStatus>;
};

export const SPORTSBOOK_PROVIDER: Token<SportsbookProvider> = createToken('SPORTSBOOK_PROVIDER');
