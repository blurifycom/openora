// Igaming-aggregator seam. An aggregator fans out to many game providers'
// catalogues; bind a concrete adapter to AGGREGATOR_ADAPTER in the
// igaming-aggregator module's plugin.ts.
import { createToken, type Token } from './token.js';

export type AggregatorGame = {
  externalId: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
};

export type AggregatorAdapter = {
  syncGameCatalog(): Promise<{ games: AggregatorGame[] }>;
  handleCallback(event: string, payload: unknown): Promise<void>;
};

export const AGGREGATOR_ADAPTER: Token<AggregatorAdapter> = createToken('AGGREGATOR_ADAPTER');
