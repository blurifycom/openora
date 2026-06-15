import { implement } from '@orpc/server';
import { getUserId, getTenantId, mapErrors, type OssContext } from '@oss/core';
import { gamingContract } from '../contract/index.js';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

export function createGamingRouter(gaming: GamingService) {
  const os = implement(gamingContract).$context<OssContext>();

  return os.router({
    listGames: os.listGames.handler(({ context }) => {
      // Authenticated callers list their verified tenant's games on the RLS-enforced
      // db (ADR-0018/0019). A pre-auth caller has no verified tenant - getTenantId
      // would throw UNAUTHORIZED. We only treat the MISSING-session case as public
      // (no leaking of unexpected errors): if auth is present, getTenantId yields the
      // verified tenant; otherwise we serve the read-only public catalog for the
      // server-side default tenant via listPublicGames (BYPASSRLS, explicit filter).
      if (context.auth?.userId) {
        return gaming.listGames(getTenantId(context));
      }
      return gaming.listPublicGames();
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

    listRounds: os.listRounds.handler(({ context }) => gaming.getUserRounds(getUserId(context))),
  });
}
