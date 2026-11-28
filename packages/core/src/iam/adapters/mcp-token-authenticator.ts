import type { McpTokenAuthentication, McpTokenAuthenticator } from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { account } from '@openora/core/pam/schema/identity';
import { mcpToken, type McpToken } from '../schema/index.js';
import { hashMcpToken, isMcpTokenFormat, mcpTokenAuthentication } from '../shared/mcp-token.js';

const CREDENTIAL_PROVIDER_ID = 'credential';

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
        createdAt: mcpToken.createdAt,
        expiresAt: mcpToken.expiresAt,
        revokedAt: mcpToken.revokedAt,
        credentialsChangedAt: account.updatedAt,
      })
      .from(mcpToken)
      .leftJoin(
        account,
        and(
          eq(account.userId, mcpToken.adminUserId),
          eq(account.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      )
      .where(eq(mcpToken.tokenHash, hashMcpToken(bearer)))
      .orderBy(desc(account.updatedAt))
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
