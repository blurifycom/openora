import { implement } from '@orpc/server';
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
}: {
  lobby: LobbyService;
  adminGuard: AdminGuard;
}) {
  const os = implement(lobbyContract).$context<OssContext>();

  return os.router({
    getLayout: os.getLayout.handler(() => lobby.getLayout()),
    listCategories: os.listCategories.handler(() => lobby.listCategories()),

    getCategoryBySlug: os.getCategoryBySlug.handler(({ input }) =>
      mapErrors({ NOT_FOUND: LobbyCategoryNotFoundError }, () =>
        lobby.getCategoryGames(input.slug),
      ),
    ),

    getFeatured: os.getFeatured.handler(() => lobby.getFeatured()),

    search: os.search.handler(({ input }) => lobby.search(input.q)),

    getAdminLayout: os.getAdminLayout.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return lobby.getAdminLayout();
    }),

    replaceLayout: os.replaceLayout.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors({ NOT_FOUND, BAD_REQUEST, CONFLICT: LobbyLayoutVersionConflictError }, () =>
        lobby.replaceLayout({ ...input, actorId: userId, ip, userAgent }),
      );
    }),
  });
}
