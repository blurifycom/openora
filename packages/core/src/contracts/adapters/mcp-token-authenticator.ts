import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';

export type McpTokenAuthentication =
  | { ok: true; tokenId: Uuid; adminId: User['id'] }
  | { ok: false; reason: 'unknown' }
  | {
      ok: false;
      reason: 'expired' | 'revoked' | 'credentials_changed';
      tokenId: Uuid;
      adminId: User['id'];
    };

export type McpTokenAuthenticator = {
  authenticate(bearer: string): Promise<McpTokenAuthentication>;
  recordCall(tokenId: Uuid): Promise<void>;
};

export const MCP_TOKEN_AUTHENTICATOR: Token<McpTokenAuthenticator> =
  createToken('MCP_TOKEN_AUTHENTICATOR');
