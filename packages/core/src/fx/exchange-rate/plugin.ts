import { DRIZZLE, createLogger, mapConcurrent } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  CRYPTO_EXCHANGE_RATE_PROVIDER,
  FIAT_EXCHANGE_RATE_PROVIDER,
  EXCHANGE_RATE_READER,
  PLATFORM_CONFIG,
  JOB_QUEUE,
  DEFAULT_CRYPTO_CURRENCIES,
  resolveDisplayCurrencies,
  resolveExchangeRatePivot,
  queue,
} from '@openora/core/contracts';
import * as z from 'zod';
import { ExchangeRateService } from './service/exchange-rate.service.js';
import { createExchangeRateRouter } from './router/index.js';
import { ExchangeRateReaderService } from './adapters/exchange-rate-reader.service.js';

const logger = createLogger('exchange-rate');

const DEFAULT_FRESH_TTL_MS = 60_000;
const DEFAULT_HARD_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;

const RATE_WARM_QUEUE = queue('exchange-rate-warm');
const RateWarmJobSchema = z.object({});
// Well inside freshTtlMs (60s default) so a warmed coin never crosses into soft-stale
// between ticks, and its hot-path readers never fall through to a synchronous vendor call.
const WARM_INTERVAL_MS = 30_000;
const WARM_CONCURRENCY = 4;

export default {
  id: 'exchange-rate',
  register(ctx) {
    // Set inside the router factory below (needs container access) and read by the warm
    // job worker, same lazily-constructed-singleton shape as wallet's sweep/reconciliation
    // services - the worker registers before the router factory runs, but is only
    // invoked once the schedule fires, by which point this is set.
    let reader: ExchangeRateReaderService | null = null;
    let warmCurrencies: readonly string[] = [];
    let warmPivot = '';

    ctx.provide(EXCHANGE_RATE_READER, (c: TypedContainer<CoreTokenCatalog>) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      const exchangeRateConfig = platformConfig.exchangeRate;
      const service = new ExchangeRateReaderService({
        drizzle: c.get(DRIZZLE),
        pivot: resolveExchangeRatePivot(exchangeRateConfig),
        cryptoProvider: c.has(CRYPTO_EXCHANGE_RATE_PROVIDER)
          ? c.get(CRYPTO_EXCHANGE_RATE_PROVIDER)
          : undefined,
        fiatProvider: c.has(FIAT_EXCHANGE_RATE_PROVIDER)
          ? c.get(FIAT_EXCHANGE_RATE_PROVIDER)
          : undefined,
        cryptoCurrencies: platformConfig.wallet?.cryptoCurrencies,
        freshTtlMs: exchangeRateConfig?.freshTtlMs ?? DEFAULT_FRESH_TTL_MS,
        hardMaxAgeMs: exchangeRateConfig?.hardMaxAgeMs ?? DEFAULT_HARD_MAX_AGE_MS,
        providerTimeoutMs: exchangeRateConfig?.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        failureCooldownMs: exchangeRateConfig?.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS,
      });
      reader = service;
      const pivot = resolveExchangeRatePivot(exchangeRateConfig);
      warmPivot = pivot;
      // The launch catalog: every crypto currency the operator actually offers, plus
      // whatever fiat it displays. Kept warm so a hot path (RG gate, rank accrual, a
      // social transfer) never waits on the vendor for a coin players actually use -
      // an unlisted currency simply falls back to the existing on-demand fetch.
      warmCurrencies = [
        ...new Set(
          [
            ...(platformConfig.wallet?.cryptoCurrencies ?? DEFAULT_CRYPTO_CURRENCIES),
            ...resolveDisplayCurrencies(platformConfig.displayCurrencies),
          ]
            .map((code) => code.toUpperCase())
            .filter((code) => code !== pivot),
        ),
      ];
      return service;
    });

    ctx.jobs.worker({
      queue: RATE_WARM_QUEUE,
      schema: RateWarmJobSchema,
      handler: async () => {
        if (!reader) {
          throw new Error('exchange rate warm-up: reader not constructed yet');
        }
        const svc = reader;
        const pivot = warmPivot;
        await mapConcurrent(warmCurrencies, WARM_CONCURRENCY, async (currency) => {
          try {
            await svc.getRate(currency, pivot);
          } catch (err) {
            logger.warn({ err, currency }, 'exchange rate warm-up failed');
          }
        });
      },
    });

    ctx.routers.add('exchangeRate', (c) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      // The pivot joins the list even when the operator does not offer it for display:
      // every cross rate is computed through it, so a quote against it is always legitimate.
      const supported = [
        ...resolveDisplayCurrencies(platformConfig.displayCurrencies),
        resolveExchangeRatePivot(platformConfig.exchangeRate),
      ];

      const jobQueue = c.get(JOB_QUEUE);
      // Idempotent schedule (keyed by scheduleId) - see wallet's custody-sweep cron for
      // the same pattern.
      void jobQueue
        .schedule(RATE_WARM_QUEUE, 'exchange-rate-warm.cron', {}, { everyMs: WARM_INTERVAL_MS })
        .catch((err) => logger.error({ err }, 'exchange-rate-warm schedule failed'));

      return createExchangeRateRouter(
        new ExchangeRateService(c.get(EXCHANGE_RATE_READER), supported),
      );
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
