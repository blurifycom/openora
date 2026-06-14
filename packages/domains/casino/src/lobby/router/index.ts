import { implement } from '@orpc/server';
import { mapErrors, type OssContext } from '@oss/core';
import { lobbyContract } from '../contract/index.js';
import { LobbyService, LobbyCategoryNotFoundError } from '../service/lobby.service.js';

export function createLobbyRouter(lobby: LobbyService) {
  const os = implement(lobbyContract).$context<OssContext>();

  return os.router({
    listCategories: os.listCategories.handler(() => lobby.listCategories()),

    getCategoryBySlug: os.getCategoryBySlug.handler(({ input }) =>
      mapErrors({ NOT_FOUND: LobbyCategoryNotFoundError }, () =>
        lobby.getCategoryGames(input.slug),
      ),
    ),

    getFeatured: os.getFeatured.handler(() => lobby.getFeatured()),

    search: os.search.handler(({ input }) => lobby.search(input.q)),
  });
}
