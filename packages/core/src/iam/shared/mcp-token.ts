import { createHash, randomBytes } from 'node:crypto';
import type { McpTokenAuthentication } from '@openora/core/contracts';
import type { McpTokenStatus } from '../contract/mcp-token.js';
import type { McpToken } from '../schema/index.js';

const MCP_TOKEN_SCHEME = 'ora_mcp_';
const MCP_TOKEN_SECRET_BYTES = 32;
const MCP_TOKEN_DISPLAY_PREFIX_LENGTH = 12;
const MCP_TOKEN_FORMAT = /^ora_mcp_[A-Za-z0-9_-]{43}$/;

type McpTokenLifecycle = Pick<McpToken, 'expiresAt' | 'revokedAt'>;

export function generateMcpToken() {
  return `${MCP_TOKEN_SCHEME}${randomBytes(MCP_TOKEN_SECRET_BYTES).toString('base64url')}`;
}

export function hashMcpToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isMcpTokenFormat(value: string) {
  return MCP_TOKEN_FORMAT.test(value);
}

export function mcpTokenDisplayPrefix(token: string) {
  return token.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LENGTH);
}

export function mcpTokenStatus(token: McpTokenLifecycle, now: Date): McpTokenStatus {
  if (token.revokedAt) {
    return 'revoked';
  }
  return token.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

type AuthenticatedMcpToken = McpTokenLifecycle &
  Pick<McpToken, 'id' | 'adminUserId' | 'createdAt'> & { credentialsChangedAt: Date | null };

/**
 * A token issued at or before its admin's latest credential change is refused as
 * `credentials_changed`, whether or not the revocation that change asked for was recorded.
 */
export function mcpTokenAuthentication(
  token: AuthenticatedMcpToken | undefined,
  now: Date,
): McpTokenAuthentication {
  if (!token) {
    return { ok: false, reason: 'unknown' };
  }
  const subject = { tokenId: token.id, adminId: token.adminUserId };
  const status = mcpTokenStatus(token, now);
  if (status !== 'active') {
    return { ok: false, reason: status, ...subject };
  }
  if (token.credentialsChangedAt && token.createdAt <= token.credentialsChangedAt) {
    return { ok: false, reason: 'credentials_changed', ...subject };
  }
  return { ok: true, ...subject };
}
