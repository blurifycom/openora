import { definePlugin } from '@oss/plugin-host';
import { GAME_ADAPTER } from '@oss/adapters';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { GamingService } from './service/gaming.service.js';
import { createGamingRouter } from './router/index.js';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';

export default definePlugin({
  id: 'gaming',
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.routers.add('gaming', (c) =>
      createGamingRouter(new GamingService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(GAME_ADAPTER))),
    );
  },
});
