import { definePlugin } from '@oss/plugin-host';
import { CasinoAggregatorService } from './service/casino-aggregator.service.js';
import { CasinoAggregatorController } from './router/index.js';

export default definePlugin({
  id: 'casino-aggregator',
  register(ctx) {
    ctx.providers.add(CasinoAggregatorService);
    ctx.controllers.add(CasinoAggregatorController);
  },
});
