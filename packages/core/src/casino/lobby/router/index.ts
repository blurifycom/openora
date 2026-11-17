import { ORPCError, implement } from '@orpc/server';
import { DEFAULT_LOBBY_LAYOUT_KEY } from '@openora/core/contracts';
import { mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { lobbyContract } from '../contract/index.js';
import {
  LobbyService,
  LobbyCategoryNotFoundError,
  LobbyLayoutVersionConflictError,
  LobbySectionFieldError,
  LobbySectionNotFoundError,
} from '../service/lobby.service.js';

const NOT_FOUND = [LobbySectionNotFoundError];
const BAD_REQUEST = [LobbySectionFieldError];

export function createLobbyRouter({
  lobby,
  adminGuard,
  keyedLayouts,
}: {
  lobby: LobbyService;
  adminGuard: AdminGuard;
  keyedLayouts: boolean;
}) {
  const os = implement(lobbyContract).$context<OssContext>();

  return os.router({
    getLayout: os.getLayout.handler(({ input }) => lobby.getLayout(input.layoutKey)),
    listCategories: os.listCategories.handler(() => lobby.listCategories()),

    getCategoryBySlug: os.getCategoryBySlug.handler(({ input }) =>
      mapErrors({ NOT_FOUND: LobbyCategoryNotFoundError }, () =>
        lobby.getCategoryGames(input.slug),
      ),
    ),

    getFeatured: os.getFeatured.handler(() => lobby.getFeatured()),

    search: os.search.handler(({ input }) => lobby.search(input.q)),

    getAdminLayout: os.getAdminLayout.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return lobby.getAdminLayout(input.layoutKey);
    }),

    replaceLayout: os.replaceLayout.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      if (!keyedLayouts && input.layoutKey !== DEFAULT_LOBBY_LAYOUT_KEY) {
        throw new ORPCError('BAD_REQUEST', {
          message: `Saving a lobby layout other than '${DEFAULT_LOBBY_LAYOUT_KEY}' is turned off`,
        });
      }
      return mapErrors({ NOT_FOUND, BAD_REQUEST, CONFLICT: LobbyLayoutVersionConflictError }, () =>
        lobby.replaceLayout({ ...input, actorId: userId, ip, userAgent }),
      );
    }),
  });
}
