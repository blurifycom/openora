export interface AggregatorGame {
  externalId: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatorProvider {
  syncGameCatalog(): Promise<{ games: AggregatorGame[] }>;
  handleCallback(event: string, payload: unknown): Promise<void>;
}

export const AGGREGATOR_PROVIDER = Symbol('AGGREGATOR_PROVIDER');
