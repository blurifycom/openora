import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@blurifycom/core/server';
import { GEO_IP_ADAPTER } from '@blurifycom/core/contracts';
import { ComplianceService } from './service/compliance.service.js';
import { createComplianceRouter } from './router/index.js';

export default definePlugin({
  id: 'compliance',
  register(ctx) {
    ctx.routers.add('compliance', (c) =>
      createComplianceRouter(
        new ComplianceService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.has(GEO_IP_ADAPTER) ? c.get(GEO_IP_ADAPTER) : null,
        ),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});
