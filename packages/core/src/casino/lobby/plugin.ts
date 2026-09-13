import { DRIZZLE, EVENT_BUS, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { CACHE, LOBBY_SECTION_CATALOG, createLobbySectionCatalog } from '@openora/core/contracts';
import { LobbyService } from './service/lobby.service.js';
import { createLobbyRouter } from './router/index.js';

export default {
  id: 'lobby',
  register(ctx) {
    ctx.provide(LOBBY_SECTION_CATALOG, () => createLobbySectionCatalog([]));
    ctx.routers.add('lobby', (c) =>
      createLobbyRouter({
        lobby: new LobbyService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(LOBBY_SECTION_CATALOG),
          c.get(CACHE),
        ),
        adminGuard: c.get(ADMIN_GUARD),
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
