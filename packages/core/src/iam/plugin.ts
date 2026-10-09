import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  ADMIN_PERMISSION_RESOLVER,
  ADMIN_PLAYER_ACTIVITY,
  ADMIN_ROLE_ASSIGNMENT_DIRECTORY,
  AUDIT_WRITER,
  IDENTITY_READER,
  MAIL_DISPATCH,
  MCP_TOKEN_AUTHENTICATOR,
  MCP_TOKEN_REVOCATION,
  PLATFORM_CONFIG,
  SESSION_COMMANDS,
  CACHE,
  RATE_LIMITER,
  domainEventSchemas,
} from '@openora/core/contracts';
import { IamService, DbAdminPermissionResolver } from './service/iam.service.js';
import { McpTokenService } from './service/mcp-token.service.js';
import { createIamRouter } from './router/index.js';
import { DrizzleAdminPlayerActivity } from './adapters/admin-player-activity.js';
import { DrizzleAdminRoleAssignmentDirectory } from './adapters/admin-role-assignment-directory.js';
import { DrizzleMcpTokenAuthenticator } from './adapters/mcp-token-authenticator.js';

const logger = createLogger('iam');

function makeMcpTokenService(c: TypedContainer<CoreTokenCatalog>) {
  return new McpTokenService({
    drizzle: c.get(DRIZZLE),
    audit: c.get(AUDIT_WRITER),
    events: c.get(EVENT_BUS),
    rateLimiter: c.get(RATE_LIMITER),
    config: c.get(PLATFORM_CONFIG).agents.mcp,
  });
}

export default {
  id: 'iam',
  dependsOn: ['identity', 'audit'],
  requiresPorts: [MAIL_DISPATCH],
  register(ctx) {
    // Captured from the provider factory so the event handlers below purge the SAME
    // singleton the AdminGuard reads (Container memoizes per token). Null until the
    // first admin request resolves it - but grant-mutation events only fire on admin
    // routes, which resolve it first, so it is always set by the time one arrives.
    let resolverRef: DbAdminPermissionResolver | null = null;
    // Tenant is resolved per request inside getGrants(), never captured at boot
    // (factories run once outside any request ALS frame).
    ctx.provide(ADMIN_PERMISSION_RESOLVER, (c) => {
      resolverRef = new DbAdminPermissionResolver(
        c.get(DRIZZLE),
        c.has(CACHE) ? c.get(CACHE) : undefined,
      );
      return resolverRef;
    });

    // Purge the grant cache the instant a grant changes so a revoked admin loses access
    // immediately instead of waiting out the TTL. assign/revoke are user-keyed (one key);
    // a role's permission change fans out to every holder (resolved in invalidateRole).
    for (const event of ['iam.role.assigned', 'iam.role.revoked'] as const) {
      ctx.events.on(event, (payload) => {
        const parsed = domainEventSchemas[event].safeParse(payload);
        if (!parsed.success || !resolverRef) {
          return;
        }
        resolverRef
          .invalidateUser(parsed.data.userId)
          .catch((err) => logger.error({ err }, 'grant cache purge failed'));
      });
    }
    ctx.events.on('iam.role.permissions.changed', (payload) => {
      const parsed = domainEventSchemas['iam.role.permissions.changed'].safeParse(payload);
      if (!parsed.success || !resolverRef) {
        return;
      }
      resolverRef
        .invalidateRole(parsed.data.roleId)
        .catch((err) => logger.error({ err }, 'grant cache purge failed'));
    });

    ctx.provide(ADMIN_PLAYER_ACTIVITY, (c) => new DrizzleAdminPlayerActivity(c.get(DRIZZLE)));
    ctx.provide(
      ADMIN_ROLE_ASSIGNMENT_DIRECTORY,
      (c) => new DrizzleAdminRoleAssignmentDirectory(c.get(DRIZZLE)),
    );
    ctx.provide(MCP_TOKEN_AUTHENTICATOR, (c) => new DrizzleMcpTokenAuthenticator(c.get(DRIZZLE)));
    ctx.provide(MCP_TOKEN_REVOCATION, (c) => makeMcpTokenService(c));

    ctx.routers.add('iam', (c) => {
      const mcpTokens = makeMcpTokenService(c);
      return createIamRouter(
        new IamService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          mailDispatch: c.get(MAIL_DISPATCH),
          identityReader: c.get(IDENTITY_READER),
          mcpTokens,
          sessionCommands: c.get(SESSION_COMMANDS),
          rateLimiter: c.get(RATE_LIMITER),
        }),
        c.get(ADMIN_GUARD),
        mcpTokens,
      );
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
