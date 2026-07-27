import { implement } from '@orpc/server';
import { AdminGuard, type OssContext } from '@openora/core/server';
import { analyticsContract } from '../contract/index.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';
import { FunnelAnalyticsService } from '../service/funnel-analytics.service.js';

export function createAnalyticsRouter(
  financial: FinancialAnalyticsService,
  funnel: FunnelAnalyticsService,
  adminGuard: AdminGuard,
) {
  const os = implement(analyticsContract).$context<OssContext>();

  return os.router({
    financial: {
      summary: os.financial.summary.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'analytics', 'view');
        return financial.summary(input);
      }),

      ggr: os.financial.ggr.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'analytics', 'view');
        return financial.ggr(input);
      }),
    },
    funnel: {
      conversion: os.funnel.conversion.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'analytics', 'view');
        return funnel.conversion(input);
      }),
    },
  });
}
