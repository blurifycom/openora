import type { McpTokenAuthentication, McpTokenAuthenticator } from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { eq, sql } from 'drizzle-orm';
import { mcpToken, type McpToken } from '../schema/index.js';
import { hashMcpToken, isMcpTokenFormat, mcpTokenAuthentication } from '../shared/mcp-token.js';

export class DrizzleMcpTokenAuthenticator implements McpTokenAuthenticator {
  constructor(private readonly drizzle: DrizzleService) {}

  async authenticate(bearer: string): Promise<McpTokenAuthentication> {
    if (!isMcpTokenFormat(bearer)) {
      return { ok: false, reason: 'unknown' };
    }
    const [token] = await this.drizzle.db
      .select({
        id: mcpToken.id,
        adminUserId: mcpToken.adminUserId,
        expiresAt: mcpToken.expiresAt,
        revokedAt: mcpToken.revokedAt,
      })
      .from(mcpToken)
      .where(eq(mcpToken.tokenHash, hashMcpToken(bearer)))
      .limit(1);
    return mcpTokenAuthentication(token, new Date());
  }

  async recordCall(tokenId: McpToken['id']) {
    await this.drizzle.db
      .update(mcpToken)
      .set({ lastUsedAt: sql`now()`, callCount: sql`${mcpToken.callCount} + 1` })
      .where(eq(mcpToken.id, tokenId));
  }
}
