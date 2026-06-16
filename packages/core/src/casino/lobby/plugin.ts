import { definePlugin } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default definePlugin({
  id: 'lobby',
  register(ctx) {
    ctx.routers.add('lobby', (c) => createLobbyRouter(new LobbyService(c.get(DRIZZLE))));
  },
});
