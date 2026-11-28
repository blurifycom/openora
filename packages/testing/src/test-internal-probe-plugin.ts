import { os } from '@orpc/server';
import {
  ADMIN_GUARD,
  type CoreTokenCatalog,
  type InternalContext,
  type Plugin,
} from '@openora/core/server';

const internal = os.$context<InternalContext>();

export default {
  id: 'testing-internal-probe',
  register(ctx) {
    ctx.routers.addInternal('probe', (c) => {
      const adminGuard = c.get(ADMIN_GUARD);
      return {
        whoami: internal.route({ method: 'GET', path: '/probe/whoami' }).handler(({ context }) => ({
          caller: context.internalCaller,
          cookieSeen: context.request.headers['cookie'] !== undefined,
        })),
        asAdmin: internal
          .route({ method: 'GET', path: '/probe/as-admin' })
          .handler(async ({ context }) => {
            const caller = await adminGuard.assert(context);
            return { userId: caller.userId };
          }),
      };
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
