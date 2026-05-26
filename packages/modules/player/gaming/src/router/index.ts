import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { getUserId, getTenantId, mapErrors } from '@oss/core';
import { gamingContract } from '@oss/orpc-contract/gaming';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

@Controller()
export class GamingController {
  constructor(private readonly gaming: GamingService) {}

  @Implement(gamingContract)
  gamingRoutes() {
    return {
      listGames: implement(gamingContract.listGames).handler(({ context }) => {
        let tenantId: string | undefined;
        try { tenantId = getTenantId(context); } catch { /* optional */ }
        return this.gaming.listGames(tenantId);
      }),

      getGame: implement(gamingContract.getGame).handler(({ input }) =>
        mapErrors({ NOT_FOUND: GameNotFoundError }, () => this.gaming.getGame(input.id)),
      ),

      startRound: implement(gamingContract.startRound).handler(({ input, context }) =>
        mapErrors(
          { NOT_FOUND: GameNotFoundError },
          () => this.gaming.startRound(getUserId(context), input.gameId, input.currency),
        ),
      ),

      endRound: implement(gamingContract.endRound).handler(({ input, context }) =>
        mapErrors(
          { NOT_FOUND: GameRoundNotFoundError },
          () => this.gaming.endRound(getUserId(context), input.roundId),
        ),
      ),

      listRounds: implement(gamingContract.listRounds).handler(({ context }) =>
        this.gaming.getUserRounds(getUserId(context)),
      ),
    };
  }
}
