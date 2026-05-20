import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { gamingContract } from '@oss/orpc-contract/gaming';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

@Controller()
export class GamingController {
  constructor(private readonly gaming: GamingService) {}

  @Implement(gamingContract)
  gamingRoutes() {
    return {
      listGames: implement(gamingContract.listGames).handler(({ context }) => {
        const req = (context as { request: RequestLike }).request;
        const tenantId = req.headers['x-tenant-id'];
        return this.gaming.listGames(typeof tenantId === 'string' ? tenantId : undefined);
      }),

      getGame: implement(gamingContract.getGame).handler(async ({ input }) => {
        try {
          return await this.gaming.getGame(input.id);
        } catch (err) {
          if (err instanceof GameNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      startRound: implement(gamingContract.startRound).handler(async ({ input, context }) => {
        const req = (context as { request: RequestLike }).request;
        const userId = req.headers['x-user-id'];
        if (typeof userId !== 'string' || !userId) {
          throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
        }
        try {
          return await this.gaming.startRound(userId, input.gameId, input.currency);
        } catch (err) {
          if (err instanceof GameNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      endRound: implement(gamingContract.endRound).handler(async ({ input, context }) => {
        const req = (context as { request: RequestLike }).request;
        const userId = req.headers['x-user-id'];
        if (typeof userId !== 'string' || !userId) {
          throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
        }
        try {
          return await this.gaming.endRound(userId, input.roundId);
        } catch (err) {
          if (err instanceof GameRoundNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      listRounds: implement(gamingContract.listRounds).handler(async ({ context }) => {
        const req = (context as { request: RequestLike }).request;
        const userId = req.headers['x-user-id'];
        if (typeof userId !== 'string' || !userId) {
          throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
        }
        return this.gaming.getUserRounds(userId);
      }),
    };
  }
}
