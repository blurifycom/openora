import { createToken, type Token } from './token.js';

export type SwapStatus = 'processing' | 'completed' | 'failed';

export type SwapQuote = {
  quoteId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  fee: string;
  feeCurrency: string;
  asOf: string;
  expiresAt: string;
};

export type SwapExecution = {
  externalId: string;
  status: SwapStatus;
  toAmount?: string;
  rate?: string;
};

export type SwapWebhookEvent = {
  kind: 'swap';
  externalId: string;
  status: SwapStatus;
  toAmount?: string;
  rate?: string;
  failureReason?: string;
};

export type SwapAdapter = {
  getQuote(input: {
    userId: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
  }): Promise<SwapQuote | null>;

  execute(input: {
    userId: string;
    quoteId?: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    idempotencyKey: string;
  }): Promise<SwapExecution>;

  supportsPair?(fromCurrency: string, toCurrency: string): boolean;

  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): SwapWebhookEvent | null;

  getSwapStatus?(externalId: string): Promise<{
    status: SwapStatus;
    toAmount?: string;
    rate?: string;
  } | null>;
};

export const SWAP_ADAPTER: Token<SwapAdapter> = createToken('SWAP_ADAPTER');

export type SwapRefusalReason =
  | 'quote_missing'
  | 'quote_invalid'
  | 'quote_expired'
  | 'quote_spent'
  | 'insufficient_inventory'
  | 'no_rate';

export class SwapRefusedError extends Error {
  readonly data: { reason: SwapRefusalReason };

  constructor(reason: SwapRefusalReason, message: string) {
    super(message);
    this.name = 'SwapRefusedError';
    this.data = { reason };
  }
}

export type SwapLimitReason = 'over_swap_limit' | 'over_daily_limit';

export class SwapLimitExceededError extends Error {
  readonly data: { reason: SwapLimitReason };

  constructor(reason: SwapLimitReason, message: string) {
    super(message);
    this.name = 'SwapLimitExceededError';
    this.data = { reason };
  }
}

export type SwapWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const SWAP_WEBHOOK_VERIFIER: Token<SwapWebhookVerifier> =
  createToken('SWAP_WEBHOOK_VERIFIER');
