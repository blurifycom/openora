import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { CRYPTO_EXCHANGE_RATE_PROVIDER, type ExchangeRateProvider } from '@openora/core/contracts';

/** What the provider quotes for every currency, against any pivot. */
export const TEST_EXCHANGE_RATE = '2.000000000000000000';

/**
 * Binds a crypto rate provider that quotes `TEST_EXCHANGE_RATE` for every currency, so a test
 * can prove a rate was fetched and stored without a vendor. Opt-in only - pass it in
 * `config.plugins`.
 */
export default {
  id: 'testing-exchange-rate-provider',
  dependsOn: ['exchange-rate'],
  register(ctx) {
    ctx.provide(
      CRYPTO_EXCHANGE_RATE_PROVIDER,
      () =>
        ({
          async getRate() {
            return { rate: TEST_EXCHANGE_RATE, asOf: new Date().toISOString() };
          },
        }) satisfies ExchangeRateProvider,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
