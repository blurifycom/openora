import { definePlugin } from '@oss/core/server';
import { GAME_ADAPTER, RNG_ADAPTER } from '@oss/core/contracts';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { GamingService } from './service/gaming.service.js';
import { createGamingRouter } from './router/index.js';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';
import { MockRngAdapter } from './adapters/mock/mock-rng-adapter.js';

export default definePlugin({
  id: 'gaming',
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.provide(RNG_ADAPTER, () => new MockRngAdapter());
    ctx.routers.add('gaming', (c) =>
      createGamingRouter(new GamingService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(GAME_ADAPTER))),
    );
  },
});
