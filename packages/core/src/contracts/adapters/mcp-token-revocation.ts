import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';
import type { McpTokenRevokeReason } from '../schemas/iam.js';

export type McpTokenAutomaticRevokeReason = Extract<
  McpTokenRevokeReason,
  'admin_disabled' | 'admin_role_removed' | 'sessions_revoked'
>;

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
