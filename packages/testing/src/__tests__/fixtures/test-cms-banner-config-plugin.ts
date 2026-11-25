import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_PERMISSION_RESOLVER,
  PLATFORM_CONFIG,
  definePlatformConfig,
} from '@openora/core/contracts';
import { DbAdminPermissionResolver } from '@openora/core/iam/server';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { eq } from 'drizzle-orm';

/** A role of this name holds `content:create` but not `content:update`, which no role level can express. */
export const CREATE_ONLY_CONTENT_ROLE = 'content-create-only';

export default {
  id: 'testing-cms-banner-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        cms: {
          allowedBannerImageHosts: ['img.example.test'],
          bannerImageCountBounds: { 'bounds-override': { carousel: { min: 1, max: 6 } } },
        },
      }),
    );
    ctx.provide(ADMIN_PERMISSION_RESOLVER, (c) => {
      const drizzle = c.get(DRIZZLE);
      const inner = new DbAdminPermissionResolver(drizzle);
      return {
        isSuperAdmin: (userId) => inner.isSuperAdmin(userId),
        async getGrants(userId) {
          const grants = await inner.getGrants(userId);
          const roles = await drizzle.db
            .select({ name: adminRole.name })
            .from(adminRoleAssignment)
            .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
            .where(eq(adminRoleAssignment.userId, userId));
          return roles.some((role) => role.name === CREATE_ONLY_CONTENT_ROLE)
            ? grants.filter((grant) => !(grant.resource === 'content' && grant.action === 'update'))
            : grants;
        },
      };
    });
  },
} satisfies Plugin<CoreTokenCatalog>;
