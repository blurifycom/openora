import { definePlugin, DRIZZLE } from '@blurifycom/core/server';
import { CACHE } from '@blurifycom/core/contracts';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default definePlugin({
  id: 'lobby',
  register(ctx) {
    ctx.routers.add('lobby', (c) =>
      createLobbyRouter(new LobbyService(c.get(DRIZZLE), c.get(CACHE))),
    );
  },
});
