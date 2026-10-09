import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';
import type { McpTokenRevokeReason } from '../schemas/iam.js';

export type McpTokenAutomaticRevokeReason = Extract<
  McpTokenRevokeReason,
  'admin_disabled' | 'admin_role_removed' | 'sessions_revoked'
>;

/**
 * Revokes every active MCP token a user holds when their standing changes. Revocation is
 * persisted, so restoring the account later does not bring the old tokens back. Pass the
 * transaction that changes the standing as `tx`, so both commit or roll back together; it is
 * typed `unknown` because this contracts-zone port cannot import drizzle's transaction type.
 */
export type McpTokenRevocation = {
  revokeAllForUser(
    input: {
      userId: User['id'];
      reason: McpTokenAutomaticRevokeReason;
      actorId: User['id'] | null;
    } & Partial<ClientMeta>,
    tx?: unknown,
  ): Promise<{ revoked: number }>;
};

export const MCP_TOKEN_REVOCATION: Token<McpTokenRevocation> = createToken('MCP_TOKEN_REVOCATION');
