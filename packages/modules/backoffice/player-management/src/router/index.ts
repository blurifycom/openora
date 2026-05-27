import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { AdminGuard } from '@oss/auth';
import { mapErrors } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

@Controller()
export class PlayerController {
  constructor(
    private readonly player: PlayerService,
    private readonly adminGuard: AdminGuard,
  ) {}

  @Implement(contract.player)
  playerRoutes() {
    return {
      list: implement(contract.player.list).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context, 'player', 'view');
        return this.player.list(input.page ?? 1, input.limit ?? 20, input.search, input.status);
      }),

      get: implement(contract.player.get).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context, 'player', 'view');
        return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => this.player.get(input.playerId));
      }),

      update: implement(contract.player.update).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context, 'player', 'update');
        return mapErrors(
          { NOT_FOUND: PlayerNotFoundError },
          () => this.player.update(input.playerId, {
            displayName: input.displayName,
            status: input.status,
            kycStatus: input.kycStatus,
            level: input.level,
          }),
        );
      }),

      remove: implement(contract.player.remove).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context, 'player', 'ban');
        return mapErrors(
          { NOT_FOUND: PlayerNotFoundError },
          () => this.player.remove(input.playerId),
        );
      }),

      registrationsOverTime: implement(contract.player.registrationsOverTime).handler(
        async ({ input, context }) => {
          await this.adminGuard.assert(context, 'report', 'view');
          return this.player.registrationsOverTime(input.days ?? 30);
        },
      ),

      summary: implement(contract.player.summary).handler(async ({ context }) => {
        await this.adminGuard.assert(context, 'report', 'view');
        return this.player.summary();
      }),
    };
  }
}
