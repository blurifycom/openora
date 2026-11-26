import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export const MCP_TEST_HOST = 'localhost';
export const MCP_TEST_ORIGIN = 'https://backoffice.example.com';
export const MCP_TEST_LIMITS = {
  perMinute: 6,
  perDay: 100,
  perIpPerMinute: 5,
  tokenTtlMaxDays: 10,
  tokenTtlDefaultDays: 5,
} as const;

export default {
  id: 'testing-mcp',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        agents: {
          mcp: {
            enabled: true,
            allowedHosts: [MCP_TEST_HOST],
            allowedOrigins: [MCP_TEST_ORIGIN],
            tokenTtlDays: {
              default: MCP_TEST_LIMITS.tokenTtlDefaultDays,
              max: MCP_TEST_LIMITS.tokenTtlMaxDays,
            },
            rateLimit: {
              perMinute: MCP_TEST_LIMITS.perMinute,
              perDay: MCP_TEST_LIMITS.perDay,
              perIpPerMinute: MCP_TEST_LIMITS.perIpPerMinute,
            },
          },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
