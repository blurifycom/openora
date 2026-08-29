import { DRIZZLE, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  CACHE,
  CRYPTO_EXCHANGE_RATE_PROVIDER,
  FIAT_EXCHANGE_RATE_PROVIDER,
  EXCHANGE_RATE_READER,
  IGAMING_CONFIG,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  type PlatformConfig,
} from '@openora/core/contracts';
import { ExchangeRateService } from './service/exchange-rate.service.js';
import { createExchangeRateRouter } from './router/index.js';
import { ExchangeRateReaderService } from './adapters/exchange-rate-reader.service.js';
import {
  ExchangeRateRefreshService,
  EXCHANGE_RATE_REFRESH_QUEUE,
  ExchangeRateRefreshJobPayloadSchema,
} from './service/exchange-rate-refresh.service.js';

const logger = createLogger('exchange-rate');

// Mirrors ExchangeRateConfigSchema's defaults - used only when the operator hasn't
// configured platformConfig.exchangeRate at all (the schema's own .default() only
// applies once the object itself is present).
const DEFAULT_PIVOT = 'USD';
const DEFAULT_REFRESH_CRON = '0 */6 * * *'; // every 6 hours

// The pivot is a comparison unit the fx module derives cross rates against
// (`from/pivot ÷ to/pivot`), NOT a system base currency - the platform has no global
// base currency, each player has their own operating currency.
function resolvePivot(platformConfig: PlatformConfig): string {
  return (platformConfig.exchangeRate?.pivot ?? DEFAULT_PIVOT).toUpperCase();
}

export default {
  id: 'exchange-rate',
  register(ctx) {
    // Set inside the router factory (container access); the job worker's handler
    // closes over this ref, same shape as wallet's custody-sweep/reconciliation jobs -
    // subscriptions/workers wire before router factories run, but are set before any
    // real job arrives.
    let refreshSvc: ExchangeRateRefreshService | null = null;

    ctx.jobs.worker({
      queue: EXCHANGE_RATE_REFRESH_QUEUE,
      schema: ExchangeRateRefreshJobPayloadSchema,
      handler: async () => {
        if (!refreshSvc) {
          throw new Error('exchange-rate refresh: service not constructed yet');
        }
        const summary = await refreshSvc.runCycle();
        logger.info(summary, 'exchange rate refresh cycle complete');
      },
    });

    // Self-bound default reader (same pattern as WALLET_ASSET_CATALOG/WALLET_READER):
    // any module can resolve EXCHANGE_RATE_READER with zero wiring. Never calls a
    // provider - see the port doc comment and ExchangeRateReaderService.
    ctx.provide(EXCHANGE_RATE_READER, (c: TypedContainer<CoreTokenCatalog>) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      return new ExchangeRateReaderService(
        c.get(DRIZZLE),
        c.has(CACHE) ? c.get(CACHE) : undefined,
        resolvePivot(platformConfig),
      );
    });

    ctx.routers.add('exchangeRate', (c) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      const pivot = resolvePivot(platformConfig);
      const currencies = c.has(IGAMING_CONFIG) ? c.get(IGAMING_CONFIG).currencies : [];

      refreshSvc = new ExchangeRateRefreshService({
        drizzle: c.get(DRIZZLE),
        cache: c.has(CACHE) ? c.get(CACHE) : undefined,
        // Both optional - core ships no concrete binding (ADR: no vendor SDK in core).
        // An operator (or overlay) binds one or both to actually get rates; absent
        // means every currency on that rail is logged and skipped every cycle.
        cryptoProvider: c.has(CRYPTO_EXCHANGE_RATE_PROVIDER)
          ? c.get(CRYPTO_EXCHANGE_RATE_PROVIDER)
          : undefined,
        fiatProvider: c.has(FIAT_EXCHANGE_RATE_PROVIDER)
          ? c.get(FIAT_EXCHANGE_RATE_PROVIDER)
          : undefined,
        pivot,
        currencies,
        cryptoCurrencies: platformConfig.wallet?.cryptoCurrencies,
      });

      const jobQueue = c.get(JOB_QUEUE);
      const refreshCron = platformConfig.exchangeRate?.refreshCron ?? DEFAULT_REFRESH_CRON;
      // Idempotent schedule (keyed by scheduleId) - registers even with zero currencies
      // configured or no provider bound, same shape as wallet's sweep/reconciliation
      // schedules: the handler just skips everything every tick until configured.
      void jobQueue
        .schedule(
          EXCHANGE_RATE_REFRESH_QUEUE,
          'exchange-rate-refresh.cron',
          {},
          { cron: refreshCron },
        )
        .catch((err) => logger.error({ err }, 'exchange-rate-refresh schedule failed'));

      return createExchangeRateRouter(new ExchangeRateService(c.get(EXCHANGE_RATE_READER)));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
