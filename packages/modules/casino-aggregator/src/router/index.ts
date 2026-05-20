import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { casinoAggregatorContract } from '@oss/orpc-contract/casino-aggregator';
import { CasinoAggregatorService } from '../service/casino-aggregator.service.js';

@Controller()
export class CasinoAggregatorController {
  constructor(private readonly aggregator: CasinoAggregatorService) {}

  @Implement(casinoAggregatorContract)
  router() {
    return {
      sync: implement(casinoAggregatorContract.sync).handler(() => {
        return this.aggregator.syncGames();
      }),

      listProviders: implement(casinoAggregatorContract.listProviders).handler(() => {
        return this.aggregator.listProviders();
      }),

      callback: implement(casinoAggregatorContract.callback).handler(async ({ input }) => {
        try {
          return await this.aggregator.handleCallback(input.provider, input.event, input.payload);
        } catch (err) {
          throw new ORPCError('INTERNAL_SERVER_ERROR', {
            message: err instanceof Error ? err.message : 'Callback handling failed',
          });
        }
      }),
    };
  }
}
