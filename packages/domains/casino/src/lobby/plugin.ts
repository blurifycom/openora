import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default definePlugin({
  id: 'lobby',
  register(ctx) {
    ctx.routers.add('lobby', (c) => createLobbyRouter(new LobbyService(c.get(DRIZZLE))));
  },
});
