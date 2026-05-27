import { implement } from '@orpc/server';
import { getUserId, getTenantId, mapErrors, type OssContext } from '@oss/core';
import { gamingContract } from '@oss/orpc-contract/gaming';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

export function createGamingRouter(gaming: GamingService) {
  const os = implement(gamingContract).$context<OssContext>();

  return os.router({
    listGames: os.listGames.handler(({ context }) => {
      let tenantId: string | undefined;
      try {
        tenantId = getTenantId(context);
      } catch {
        /* optional */
      }
      return gaming.listGames(tenantId);
    }),

    getGame: os.getGame.handler(({ input }) =>
      mapErrors({ NOT_FOUND: GameNotFoundError }, () => gaming.getGame(input.id)),
    ),

    startRound: os.startRound.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: GameNotFoundError }, () =>
        gaming.startRound(getUserId(context), input.gameId, input.currency),
      ),
    ),

    endRound: os.endRound.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: GameRoundNotFoundError }, () =>
        gaming.endRound(getUserId(context), input.roundId),
      ),
    ),

    listRounds: os.listRounds.handler(({ context }) =>
      gaming.getUserRounds(getUserId(context)),
    ),
  });
}
