import { CACHE, MONEY_REPORTING } from '@openora/core/contracts';
import { ADMIN_GUARD, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { financialSummaryTool, ggrSummaryTool, paymentsFlowDailyTool } from './contract/index.js';
import { FinancialAnalyticsService } from './service/financial-analytics.service.js';
import { FunnelAnalyticsService } from './service/funnel-analytics.service.js';
import { createAnalyticsRouter } from './router/index.js';

export default {
  id: 'analytics',
  dependsOn: ['identity', 'profile'],
  // The money tables are read by the wallet, through its reporting port.
  requiresPorts: [MONEY_REPORTING],
  register(ctx) {
    let financialRef: FinancialAnalyticsService | null = null;
    const financialAnalytics = (c: TypedContainer<CoreTokenCatalog>) =>
      (financialRef ??= new FinancialAnalyticsService(c.get(MONEY_REPORTING), c.get(CACHE)));

    ctx.mcp.tool(ggrSummaryTool, (c) => {
      const financial = financialAnalytics(c);
      return (input) => financial.ggrSummary(input);
    });
    ctx.mcp.tool(financialSummaryTool, (c) => {
      const financial = financialAnalytics(c);
      return (input) => financial.financialSummary(input);
    });
    ctx.mcp.tool(paymentsFlowDailyTool, (c) => {
      const financial = financialAnalytics(c);
      return (input) => financial.paymentsFlow(input);
    });

    ctx.routers.add('analytics', (c) =>
      createAnalyticsRouter(
        financialAnalytics(c),
        new FunnelAnalyticsService(c.get(DRIZZLE), c.get(CACHE), c.get(MONEY_REPORTING)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
