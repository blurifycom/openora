import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';

/**
 * Answers for the token alone. Whether its admin may still use MCP is AdminGuard's call, made
 * on every request, so a disabled account is refused even before its tokens are revoked.
 */
export type McpTokenAuthentication =
  | { ok: true; tokenId: Uuid; adminId: User['id'] }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'expired' | 'revoked'; tokenId: Uuid; adminId: User['id'] };

export type McpTokenAuthenticator = {
  authenticate(bearer: string): Promise<McpTokenAuthentication>;
  /** Counts one tool call against the token and stamps its last use. */
  recordCall(tokenId: Uuid): Promise<void>;
};

export const MCP_TOKEN_AUTHENTICATOR: Token<McpTokenAuthenticator> =
  createToken('MCP_TOKEN_AUTHENTICATOR');
