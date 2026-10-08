import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { MCP_TOKEN_REVOCATION } from '@openora/core/contracts';

export default {
  id: 'test-failing-mcp-token-revocation',
  dependsOn: ['iam'],
  register(ctx) {
    ctx.provide(MCP_TOKEN_REVOCATION, () => ({
      revokeAllForUser: async () => {
        throw new Error('MCP token revocation is unavailable');
      },
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
