import { implement } from '@orpc/server';
import { type OssContext, getUserId } from '@openora/core/server';
import { exchangeRateContract } from '../contract/index.js';
import { ExchangeRateService } from '../service/exchange-rate.service.js';

// oRPC router factory for ExchangeRate. plugin.ts builds the service from the
// container and passes it here; each procedure delegates to the service. Keep this
// thin: resolve the caller, call the service, map domain errors - no business rules.
//
// Both routes resolve the caller even though neither uses the id: a route is anonymous
// unless its handler resolves one, and a miss on either route fetches synchronously from
// the rate provider. Left open, an anonymous caller could drive unbounded outbound vendor
// spend - `getRates` alone accepts 50 source currencies per request, and a pair that never
// resolves is never stored, so every repeat re-issues the call. `getUserId` throws
// UNAUTHORIZED when no session is attached, which is the entire guard.
export function createExchangeRateRouter(exchangeRate: ExchangeRateService) {
  const os = implement(exchangeRateContract).$context<OssContext>();

  return os.router({
    getRate: os.getRate.handler(({ input, context }) => {
      getUserId(context);
      return exchangeRate.getRate(input.from, input.to);
    }),
    getRates: os.getRates.handler(({ input, context }) => {
      getUserId(context);
      return exchangeRate.getRates(input.to, input.from);
    }),
  });
}
