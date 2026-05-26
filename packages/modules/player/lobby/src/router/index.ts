import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { mapErrors } from '@oss/core';
import { lobbyContract } from '@oss/orpc-contract/lobby';
import { LobbyService, LobbyCategoryNotFoundError } from '../service/lobby.service.js';

@Controller()
export class LobbyController {
  constructor(private readonly lobby: LobbyService) {}

  @Implement(lobbyContract)
  lobbyRouter() {
    return {
      listCategories: implement(lobbyContract.listCategories).handler(() =>
        this.lobby.listCategories(),
      ),

      getCategoryBySlug: implement(lobbyContract.getCategoryBySlug).handler(({ input }) =>
        mapErrors(
          { NOT_FOUND: LobbyCategoryNotFoundError },
          () => this.lobby.getCategoryGames(input.slug),
        ),
      ),

      getFeatured: implement(lobbyContract.getFeatured).handler(() => this.lobby.getFeatured()),

      search: implement(lobbyContract.search).handler(({ input }) => this.lobby.search(input.q)),
    };
  }
}
