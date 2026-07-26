import { definePlugin, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import { GAME_ADAPTER, PLAY_ELIGIBILITY, RNG_ADAPTER } from '@openora/core/contracts';
import { GamingService } from './service/gaming.service.js';
import { createGamingRouter } from './router/index.js';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';
import { MockRngAdapter } from './adapters/mock/mock-rng-adapter.js';

export default definePlugin({
  id: 'gaming',
  requiresPorts: [PLAY_ELIGIBILITY],
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.provide(RNG_ADAPTER, () => new MockRngAdapter());
    ctx.routers.add('gaming', (c) =>
      createGamingRouter(
        new GamingService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(GAME_ADAPTER),
          c.get(PLAY_ELIGIBILITY),
        ),
      ),
    );
  },
});
