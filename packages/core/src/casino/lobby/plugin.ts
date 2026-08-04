import { definePlugin, DRIZZLE, CORE_TOKEN_CATALOG } from '@openora/core/server';
import { CACHE } from '@openora/core/contracts';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default definePlugin(CORE_TOKEN_CATALOG, {
  id: 'lobby',
  register(ctx) {
    ctx.routers.add('lobby', (c) =>
      createLobbyRouter(new LobbyService(c.get(DRIZZLE), c.get(CACHE))),
    );
  },
});
