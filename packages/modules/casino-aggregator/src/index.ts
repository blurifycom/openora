export {
  CasinoAggregatorService,
  AggregatorProviderNotFoundError,
} from './service/casino-aggregator.service.js';
export { CasinoAggregatorController } from './router/index.js';
export { AGGREGATOR_PROVIDER } from './service/ports.js';
export type { AggregatorProvider, AggregatorGame } from './service/ports.js';
export { default } from './plugin.js';
