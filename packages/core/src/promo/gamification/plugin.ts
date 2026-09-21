import { AUDIT_WRITER, EXCHANGE_RATE_READER, WAGER_TRACKING } from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  DRIZZLE,
  createLogger,
  type CoreTokenCatalog,
  type Plugin,
  type TypedContainer,
} from '@openora/core/server';
import { RankAdminService } from './service/rank-admin.service.js';
import { RankService } from './service/rank.service.js';
import { createGamificationRouter } from './router/index.js';

const logger = createLogger('promo-gamification');

const rankService = (c: TypedContainer<CoreTokenCatalog>) =>
  new RankService(c.get(DRIZZLE), c.get(EXCHANGE_RATE_READER), c.get(AUDIT_WRITER), logger);

export default {
  id: 'gamification',
  dependsOn: ['exchange-rate', 'audit'],
  register(ctx) {
    ctx.provide(WAGER_TRACKING, rankService);
    ctx.routers.add('promo-gamification', (c) =>
      createGamificationRouter({
        ranks: rankService(c),
        admin: new RankAdminService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        adminGuard: c.get(ADMIN_GUARD),
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
