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

// Verifies the public M2M callback is genuinely from the aggregator. The default
// impl recomputes an HMAC-SHA256 over the raw request body and constant-time
// compares it against the `x-aggregator-signature` header; a vendor overlay can
// rebind it to match that vendor's scheme. Fails closed when the secret is unset,
// the signature header is absent, or the raw body was not captured.
export type AggregatorWebhookVerifier = {
  verify(rawBody: string, signature: string | null): boolean;
};

export const AGGREGATOR_WEBHOOK_VERIFIER: Token<AggregatorWebhookVerifier> = createToken(
  'AGGREGATOR_WEBHOOK_VERIFIER',
);
