// Igaming-aggregator seam. An aggregator fans out to many game providers'
// catalogues; bind a concrete adapter to AGGREGATOR_ADAPTER in the
// igaming-aggregator module's plugin.ts.

export interface AggregatorGame {
  externalId: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatorAdapter {
  syncGameCatalog(): Promise<{ games: AggregatorGame[] }>;
  handleCallback(event: string, payload: unknown): Promise<void>;
}

export const AGGREGATOR_ADAPTER = Symbol('AGGREGATOR_ADAPTER');
