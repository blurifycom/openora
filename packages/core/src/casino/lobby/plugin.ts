import { definePluginWithCatalog, DRIZZLE, type CoreTokenCatalog } from '@openora/core/server';
import { CACHE } from '@openora/core/contracts';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default definePluginWithCatalog<CoreTokenCatalog>()({
  id: 'lobby',
  register(ctx) {
    ctx.routers.add('lobby', (c) =>
      createLobbyRouter(new LobbyService(c.get(DRIZZLE), c.get(CACHE))),
    );
  },
});
