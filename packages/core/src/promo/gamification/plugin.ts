import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { GamificationService } from './service/gamification.service.js';
import { createGamificationRouter } from './router/index.js';

// DI wiring only - no business logic here. The router factory resolves deps from
// the container at boot (after every plugin registered), so an overlay can rebind
// an adapter token (last registration wins) without a fork.
export default {
  id: 'gamification',
  // dependsOn: ['identity'], // declare deps so the loader boots them first
  register(ctx) {
    // AGENT: bind any vendor adapters before mounting the router, e.g.
    //   ctx.provide(SOME_ADAPTER, () => new MockSomeAdapter());
    ctx.routers.add('gamification', (c) =>
      createGamificationRouter(new GamificationService(c.get(DRIZZLE), c.get(EVENT_BUS))),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
