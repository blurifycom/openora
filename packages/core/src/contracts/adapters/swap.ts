/** Bind a concrete `SwapAdapter` to `SWAP_ADAPTER` in an overlay; core never binds one. Never price a swap off the exchange-rate reader - only `SwapQuote.toAmount` is binding. */
import { createToken, type Token } from './token.js';

/** `processing` covers every non-terminal vendor status. */
export type SwapStatus = 'processing' | 'completed' | 'failed';

/**
 * `toAmount` is what the player actually receives, net of `fee`, and is the only binding
 * number - `rate` is never multiplied to reach it. Amounts are decimal strings. `expiresAt`
 * and `asOf` are vendor timestamps.
 */
export type SwapQuote = {
  quoteId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  fee: string;
  /** The currency `fee` is denominated in - a vendor may charge it either side of the pair. */
  feeCurrency: string;
  asOf: string;
  expiresAt: string;
};

/** `toAmount`/`rate` are optional: an async vendor reports them later via `parseWebhook`/`getSwapStatus`. */
export type SwapExecution = {
  externalId: string;
  status: SwapStatus;
  toAmount?: string;
  rate?: string;
};

/** `toAmount` on a `completed` event is the amount actually filled; the credit must use this number, never the quoted one. */
export type SwapWebhookEvent = {
  kind: 'swap';
  externalId: string;
  status: SwapStatus;
  toAmount?: string;
  rate?: string;
  failureReason?: string;
};

export type SwapAdapter = {
  /**
   * Returns `null` when the vendor will not quote the pair at all; a thrown error means the call itself failed.
   * `userId` is the player asking, so a desk can bind the quote to them and refuse it from anyone else at `execute`.
   */
  getQuote(input: {
    userId: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
  }): Promise<SwapQuote | null>;

  /**
   * The vendor must dedupe a retry on `idempotencyKey` and return the original execution
   * rather than trading the player's funds twice. An adapter whose vendor has expired the
   * quote must throw rather than silently fill at a worse price.
   */
  execute(input: {
    userId: string;
    quoteId?: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    idempotencyKey: string;
  }): Promise<SwapExecution>;

  /** Optional; an adapter that omits it is assumed to accept anything, and `getQuote` returning `null` is then the only signal. */
  supportsPair?(fromCurrency: string, toCurrency: string): boolean;

  /** Returns `null` when the body is not a swap webhook. Optional: a synchronous vendor never sends one. */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): SwapWebhookEvent | null;

  /** Returns `null` when the vendor has no record of it. */
  getSwapStatus?(externalId: string): Promise<{
    status: SwapStatus;
    toAmount?: string;
    rate?: string;
  } | null>;
};

export const SWAP_ADAPTER: Token<SwapAdapter> = createToken('SWAP_ADAPTER');

/**
 * `quote_invalid` covers a tampered quote id and one issued to another player - the caller
 * must not learn which. `no_rate` means the desk could not value the swap to check a limit.
 */
export type SwapRefusalReason =
  | 'quote_missing'
  | 'quote_invalid'
  | 'quote_expired'
  | 'quote_spent'
  | 'insufficient_inventory'
  | 'no_rate';

/**
 * Thrown by `getQuote`/`execute` when the desk refuses a swap the player can retry later or
 * with a fresh quote. The router answers CONFLICT with `data.reason`; any other throw is a 500.
 */
export class SwapRefusedError extends Error {
  readonly data: { reason: SwapRefusalReason };

  constructor(reason: SwapRefusalReason, message: string) {
    super(message);
    this.name = 'SwapRefusedError';
    this.data = { reason };
  }
}

export type SwapLimitReason = 'over_swap_limit' | 'over_daily_limit';

/** Thrown by `getQuote`/`execute` when the swap is larger than the desk allows; the router answers BAD_REQUEST. */
export class SwapLimitExceededError extends Error {
  readonly data: { reason: SwapLimitReason };

  constructor(reason: SwapLimitReason, message: string) {
    super(message);
    this.name = 'SwapLimitExceededError';
    this.data = { reason };
  }
}

/** Its own token, not a reuse of `PAYMENT_WEBHOOK_VERIFIER`: the swap vendor signs with a different key. Fails closed. */
export type SwapWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const SWAP_WEBHOOK_VERIFIER: Token<SwapWebhookVerifier> =
  createToken('SWAP_WEBHOOK_VERIFIER');
