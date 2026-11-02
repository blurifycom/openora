import {
  AUDIT_WRITER,
  MCP_TOKEN_REVOCATION,
  PLATFORM_CONFIG,
  RATE_LIMITER,
} from '@openora/core/contracts';
import { McpTokenService } from '@openora/core/iam/server';
import { DRIZZLE, EVENT_BUS, type CoreTokenCatalog, type Plugin } from '@openora/core/server';

type Gate = { entered: () => void; released: Promise<void> };

let armed: Gate | null = null;

/**
 * Holds the next revocation once it has run, before it returns to its caller, until `release`:
 * a test orders a race against the revocation's transaction without timing. Every other
 * revocation passes straight through.
 */
export function holdNextRevocation() {
  let entered = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  armed = { entered, released };
  return { reached, release };
}

export default {
  id: 'test-gated-mcp-token-revocation',
  dependsOn: ['iam'],
  register(ctx) {
    ctx.provide(MCP_TOKEN_REVOCATION, (c) => {
      const tokens = new McpTokenService({
        drizzle: c.get(DRIZZLE),
        audit: c.get(AUDIT_WRITER),
        events: c.get(EVENT_BUS),
        rateLimiter: c.get(RATE_LIMITER),
        config: c.get(PLATFORM_CONFIG).agents.mcp,
      });
      return {
        revokeAllForUser: async (input, tx) => {
          const result = await tokens.revokeAllForUser(input, tx);
          const gate = armed;
          if (gate) {
            armed = null;
            gate.entered();
            await gate.released;
          }
          return result;
        },
      };
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
