import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_PERMISSION_RESOLVER,
  ADMIN_PLAYER_ACTIVITY,
  SEND_EMAIL,
  SESSION_COMMANDS,
  CACHE,
  domainEventSchemas,
} from '@openora/core/contracts';
import { IamService, DbAdminPermissionResolver } from './service/iam.service.js';
import { createIamRouter } from './router/index.js';
import { DrizzleAdminPlayerActivity } from './adapters/admin-player-activity.js';

const logger = createLogger('iam');

export default {
  id: 'iam',
  dependsOn: ['identity'],
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

    ctx.routers.add('iam', (c) =>
      createIamRouter(
        new IamService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(SEND_EMAIL),
          c.get(SESSION_COMMANDS),
        ),
        c.get(ADMIN_GUARD),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
