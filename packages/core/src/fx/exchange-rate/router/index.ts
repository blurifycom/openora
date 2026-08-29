import { implement } from '@orpc/server';
import { type OssContext } from '@openora/core/server';
import { exchangeRateContract } from '../contract/index.js';
import { ExchangeRateService } from '../service/exchange-rate.service.js';

// oRPC router factory for ExchangeRate. plugin.ts builds the service from the
// container and passes it here; each procedure delegates to the service. Keep this
// thin: resolve the caller, call the service, map domain errors - no business rules.
export function createExchangeRateRouter(exchangeRate: ExchangeRateService) {
  const os = implement(exchangeRateContract).$context<OssContext>();

  return os.router({
    getRate: os.getRate.handler(({ input }) => exchangeRate.getRate(input.from, input.to)),
    getRates: os.getRates.handler(({ input }) => exchangeRate.getRates(input.to, input.from)),
  });
}
