import * as z from 'zod';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  PLATFORM_CONFIG,
  UuidSchema,
  defineMcpTool,
  definePlatformConfig,
} from '@openora/core/contracts';

export const MCP_TEST_RATE_LIMIT = { perMinute: 20, perDay: 1_000 } as const;

const flagPlayerTool = defineMcpTool({
  id: 'flag_player',
  title: 'Flag player',
  description: 'Proposes a review flag on one player.',
  class: 'propose',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: z.object({ playerId: UuidSchema }),
  outputSchema: z.object({ flagged: z.boolean() }),
  redact: { allow: ['flagged'] },
  errors: [],
});

export default {
  id: 'test-mcp-transport',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        agents: {
          mcp: {
            enabled: true,
            allowedHosts: ['localhost'],
            rateLimit: MCP_TEST_RATE_LIMIT,
            tokenIssuance: { maxActivePerAdmin: 50, perHour: 1_000 },
          },
        },
      }),
    );
    ctx.mcp.tool(flagPlayerTool, () => async () => ({ flagged: true }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
