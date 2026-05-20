import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { contract } from '@oss/orpc-contract';
import type { Request } from 'express';
import { PlayerService, PlayerNotFoundError, ForbiddenError } from '../service/player.service.js';

type Ctx = { request: Request };

@Controller()
export class PlayerController {
  constructor(private readonly player: PlayerService) {}

  @Implement(contract.player)
  playerRoutes() {
    // Every PAM route is admin-gated. `guard` resolves the session, checks the
    // caller's role, and maps domain errors to oRPC errors.
    const guard = async (context: unknown): Promise<void> => {
      const { request } = context as Ctx;
      try {
        await this.player.assertAdmin(request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          throw new ORPCError('FORBIDDEN', { message: err.message });
        }
        throw err;
      }
    };

    const notFound = (err: unknown): never => {
      if (err instanceof PlayerNotFoundError) {
        throw new ORPCError('NOT_FOUND', { message: err.message });
      }
      throw err;
    };

    return {
      list: implement(contract.player.list).handler(async ({ input, context }) => {
        await guard(context);
        return this.player.list(input.page ?? 1, input.limit ?? 20, input.search, input.status);
      }),

      get: implement(contract.player.get).handler(async ({ input, context }) => {
        await guard(context);
        try {
          return await this.player.get(input.playerId);
        } catch (err) {
          return notFound(err);
        }
      }),

      update: implement(contract.player.update).handler(async ({ input, context }) => {
        await guard(context);
        try {
          return await this.player.update(input.playerId, {
            displayName: input.displayName,
            status: input.status,
            kycStatus: input.kycStatus,
            level: input.level,
          });
        } catch (err) {
          return notFound(err);
        }
      }),

      remove: implement(contract.player.remove).handler(async ({ input, context }) => {
        await guard(context);
        try {
          return await this.player.remove(input.playerId);
        } catch (err) {
          return notFound(err);
        }
      }),

      registrationsOverTime: implement(contract.player.registrationsOverTime).handler(
        async ({ input, context }) => {
          await guard(context);
          return this.player.registrationsOverTime(input.days ?? 30);
        },
      ),

      summary: implement(contract.player.summary).handler(async ({ context }) => {
        await guard(context);
        return this.player.summary();
      }),
    };
  }
}
