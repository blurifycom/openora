import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  CRYPTO_EXCHANGE_RATE_PROVIDER,
  FIAT_EXCHANGE_RATE_PROVIDER,
  EXCHANGE_RATE_READER,
  PLATFORM_CONFIG,
  resolveDisplayCurrencies,
  type PlatformConfig,
} from '@openora/core/contracts';
import { ExchangeRateService } from './service/exchange-rate.service.js';
import { createExchangeRateRouter } from './router/index.js';
import { ExchangeRateReaderService } from './adapters/exchange-rate-reader.service.js';

const DEFAULT_PIVOT = 'USD';
const DEFAULT_FRESH_TTL_MS = 60_000;
const DEFAULT_HARD_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;

function resolvePivot(platformConfig: PlatformConfig): string {
  return (platformConfig.exchangeRate?.pivot ?? DEFAULT_PIVOT).toUpperCase();
}

export default {
  id: 'exchange-rate',
  register(ctx) {
    ctx.provide(EXCHANGE_RATE_READER, (c: TypedContainer<CoreTokenCatalog>) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      const exchangeRateConfig = platformConfig.exchangeRate;
      return new ExchangeRateReaderService({
        drizzle: c.get(DRIZZLE),
        pivot: resolvePivot(platformConfig),
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
      });
    });

    ctx.routers.add('exchangeRate', (c) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      // The pivot joins the list even when the operator does not offer it for display:
      // every cross rate is computed through it, so a quote against it is always legitimate.
      const supported = [
        ...resolveDisplayCurrencies(platformConfig.displayCurrencies),
        resolvePivot(platformConfig),
      ];
      return createExchangeRateRouter(
        new ExchangeRateService(c.get(EXCHANGE_RATE_READER), supported),
      );
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
