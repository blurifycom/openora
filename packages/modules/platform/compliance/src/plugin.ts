import { definePlugin } from '@oss/plugin-host';
import { GEO_IP_ADAPTER } from '@oss/adapters';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { ComplianceService } from './service/compliance.service.js';
import { createComplianceRouter } from './router/index.js';

export default definePlugin({
  id: 'compliance',
  register(ctx) {
    // GEO_IP_ADAPTER is optional - bind a real vendor (eg MaxMind) via overlay.
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
