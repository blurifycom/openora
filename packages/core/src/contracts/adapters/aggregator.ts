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

export type AggregatorWebhookVerifier = {
  verify(rawBody: string, signature: string | null): boolean;
};

export const AGGREGATOR_WEBHOOK_VERIFIER: Token<AggregatorWebhookVerifier> = createToken(
  'AGGREGATOR_WEBHOOK_VERIFIER',
);
