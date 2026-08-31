import { implement } from '@orpc/server';
import { type OssContext, getUserId } from '@openora/core/server';
import { exchangeRateContract } from '../contract/index.js';
import { ExchangeRateService } from '../service/exchange-rate.service.js';

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
