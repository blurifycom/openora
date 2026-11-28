import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  CRYPTO_EXCHANGE_RATE_PROVIDER,
  FIAT_EXCHANGE_RATE_PROVIDER,
  type ExchangeRateProvider,
} from '@openora/core/contracts';

export const TEST_EXCHANGE_RATE = '2.000000000000000000';

export default {
  id: 'testing-exchange-rate-provider',
  dependsOn: ['exchange-rate'],
  register(ctx) {
    const provider = {
      async getRate() {
        return { rate: TEST_EXCHANGE_RATE, asOf: new Date().toISOString() };
      },
    } satisfies ExchangeRateProvider;
    ctx.provide(CRYPTO_EXCHANGE_RATE_PROVIDER, () => provider);
    ctx.provide(FIAT_EXCHANGE_RATE_PROVIDER, () => provider);
  },
} satisfies Plugin<CoreTokenCatalog>;
