import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { gamingContract } from '../contract/index.js';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
  RgRestrictedError,
  InsufficientBalanceError,
} from '../service/gaming.service.js';
import { RgLimitExceededError } from '@openora/core/contracts';

export function createGamingRouter(gaming: GamingService) {
  const os = implement(gamingContract).$context<OssContext>();

  return os.router({
    listGames: os.listGames.handler(() => gaming.listGames()),

    getGame: os.getGame.handler(({ input }) =>
      mapErrors({ NOT_FOUND: GameNotFoundError }, () => gaming.getGame(input.id)),
    ),

    startRound: os.startRound.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: GameNotFoundError,
          CONFLICT: [RgRestrictedError, RgLimitExceededError],
          BAD_REQUEST: InsufficientBalanceError,
        },
        () => gaming.startRound(getUserId(context), input.gameId, input.currency, input.betAmount),
      ),
    ),

    endRound: os.endRound.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: GameRoundNotFoundError }, () =>
        gaming.endRound(getUserId(context), input.roundId),
      ),
    ),

    listRounds: os.listRounds.handler(({ context }) => gaming.getUserRounds(getUserId(context))),
  });
}
