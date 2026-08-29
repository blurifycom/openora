// Internal barrel of the ExchangeRate module. The public consumer surface is the
// domain barrel (@openora/core/fx), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/fx/schema/exchange-rate.
export { ExchangeRateService } from './service/exchange-rate.service.js';
export { createExchangeRateRouter } from './router/index.js';
