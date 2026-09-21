import { EXCHANGE_RATE_READER, WAGER_TRACKING } from '@openora/core/contracts';
import {
  DRIZZLE,
  createLogger,
  type CoreTokenCatalog,
  type Plugin,
  type TypedContainer,
} from '@openora/core/server';
import { RankService } from './service/rank.service.js';
import { createGamificationRouter } from './router/index.js';

const logger = createLogger('promo-gamification');

const rankService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), logger);

export default {
  id: 'gamification',
  dependsOn: ['exchange-rate'],
  register(ctx) {
    ctx.provide(WAGER_TRACKING, rankService);
    ctx.routers.add('promo-gamification', (c) =>
      createGamificationRouter({ ranks: rankService(c) }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
