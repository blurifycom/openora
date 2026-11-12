import { os } from '@orpc/server';
import type { CoreTokenCatalog, InternalContext, Plugin } from '@openora/core/server';

const internal = os.$context<InternalContext>();

/** One internal route that answers with who it thinks called, for the internal API suites. */
export default {
  id: 'testing-internal-probe',
  register(ctx) {
    ctx.routers.addInternal('probe', () => ({
      whoami: internal.route({ method: 'GET', path: '/probe/whoami' }).handler(({ context }) => ({
        caller: context.internalCaller,
        userId: context.auth?.userId ?? null,
      })),
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
