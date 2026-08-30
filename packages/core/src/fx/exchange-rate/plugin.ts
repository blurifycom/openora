import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  CRYPTO_EXCHANGE_RATE_PROVIDER,
  FIAT_EXCHANGE_RATE_PROVIDER,
  EXCHANGE_RATE_READER,
  PLATFORM_CONFIG,
  type PlatformConfig,
} from '@openora/core/contracts';
import { ExchangeRateService } from './service/exchange-rate.service.js';
import { createExchangeRateRouter } from './router/index.js';
import { ExchangeRateReaderService } from './adapters/exchange-rate-reader.service.js';

// Mirrors ExchangeRateConfigSchema's defaults - used only when the operator hasn't
// configured platformConfig.exchangeRate at all (the schema's own .default() only
// applies once the object itself is present).
const DEFAULT_PIVOT = 'USD';
const DEFAULT_FRESH_TTL_MS = 60_000;
const DEFAULT_HARD_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;

// The pivot is a comparison unit the fx module derives cross rates against
// (`from/pivot ÷ to/pivot`), NOT a system base currency - the platform has no global
// base currency, each player has their own operating currency.
function resolvePivot(platformConfig: PlatformConfig): string {
  return (platformConfig.exchangeRate?.pivot ?? DEFAULT_PIVOT).toUpperCase();
}

export default {
  id: 'exchange-rate',
  register(ctx) {
    // Self-bound default reader (same pattern as WALLET_ASSET_CATALOG/WALLET_READER):
    // any module can resolve EXCHANGE_RATE_READER with zero wiring. Read-through
    // cache: a fresh stored quote answers with no vendor call; see
    // ExchangeRateReaderService and the port's doc comment.
    ctx.provide(EXCHANGE_RATE_READER, (c: TypedContainer<CoreTokenCatalog>) => {
      const platformConfig = c.get(PLATFORM_CONFIG);
      const exchangeRateConfig = platformConfig.exchangeRate;
      return new ExchangeRateReaderService({
        drizzle: c.get(DRIZZLE),
        pivot: resolvePivot(platformConfig),
        // Both optional - core ships no concrete binding (ADR: no vendor SDK in
        // core). An operator (or overlay) binds one or both to actually get rates;
        // absent means every currency on that rail always resolves `null`.
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
      return createExchangeRateRouter(new ExchangeRateService(c.get(EXCHANGE_RATE_READER)));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
