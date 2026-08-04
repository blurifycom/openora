import { CACHE } from '@openora/core/contracts';
import { definePlugin, ADMIN_GUARD, DRIZZLE, type CoreTokenCatalog } from '@openora/core/server';
import { FinancialAnalyticsService } from './service/financial-analytics.service.js';
import { FunnelAnalyticsService } from './service/funnel-analytics.service.js';
import { createAnalyticsRouter } from './router/index.js';

export default definePlugin<CoreTokenCatalog>()({
  id: 'analytics',
  dependsOn: ['wallet', 'identity', 'profile', 'gaming'],
  register(ctx) {
    ctx.routers.add('analytics', (c) =>
      createAnalyticsRouter(
        new FinancialAnalyticsService(c.get(DRIZZLE), c.get(CACHE)),
        new FunnelAnalyticsService(c.get(DRIZZLE), c.get(CACHE)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
