/**
 * Currency-swap seam. A swap vendor (an exchange or a custody rail that can trade one
 * asset for another) implements `SwapAdapter`; bind a concrete adapter to `SWAP_ADAPTER`
 * in an overlay. Core never binds one - an operator who binds nothing simply has no swap
 * feature, the same way an operator binds no `PAYMENT_ADAPTER` until they pick a PSP.
 *
 * This is deliberately NOT the exchange-rate seam. `CRYPTO_EXCHANGE_RATE_PROVIDER` /
 * `FIAT_EXCHANGE_RATE_PROVIDER` answer "what is this worth" for display and for limit
 * arithmetic, and never move money. A `SwapAdapter` moves it, at a price the vendor
 * commits to, and the two numbers will differ - a reference rate is not a tradeable one,
 * once spread and fee are in. Never price a swap off the rate reader.
 */
import { createToken, type Token } from './token.js';

/**
 * Terminal-or-not state of one swap at the vendor. `processing` covers everything a
 * vendor may call "pending", "confirming", "exchanging" and so on - core only needs to
 * know whether it may settle yet, so an adapter collapses the vendor's own vocabulary
 * onto these three.
 */
export type SwapStatus = 'processing' | 'completed' | 'failed';

/**
 * A vendor's committed price for one swap, valid until `expiresAt`.
 *
 * `toAmount` is what the player actually receives - net of `fee`, not gross - so a client
 * renders it without arithmetic of its own and cannot disagree with the ledger about what
 * was promised. `rate` is reported alongside for the audit record and for display; it is
 * never the thing multiplied to reach `toAmount`, because a vendor is free to price a
 * swap however it likes and only `toAmount` is binding.
 *
 * Every amount is a decimal string, never a float, so it survives a Postgres `NUMERIC`
 * round-trip exactly. `expiresAt` and `asOf` are ISO timestamps from the vendor.
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

/**
 * The vendor's acknowledgement of an executed swap. `externalId` is the vendor's own
 * reference and the dedup key settlement reconciles against.
 *
 * `toAmount` and `rate` are optional because an async vendor does not know the filled
 * amount at submission time - it reports them later, through `parseWebhook` or
 * `getSwapStatus`. A synchronous vendor may return `completed` with both already set,
 * and then no settlement round-trip is needed.
 */
export type SwapExecution = {
  externalId: string;
  status: SwapStatus;
  toAmount?: string;
  rate?: string;
};

/**
 * Normalized inbound swap webhook, produced by `SwapAdapter.parseWebhook`. Mirrors
 * `PaymentWebhookEvent`'s withdrawal arm: the same shape of problem (an async vendor
 * telling us a money move reached a terminal state) gets the same shape of answer.
 *
 * `toAmount` on a `completed` event is the amount actually filled. It may differ from the
 * quote - the credit must use THIS number, never the quoted one, or the ledger credits
 * money the vendor did not deliver.
 */
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
   * Price a swap without committing to it. Returns `null` when the vendor will not quote
   * the pair at all (unsupported, below a minimum, no liquidity) - that is an ordinary
   * answer, not a failure. A thrown error means the call itself failed.
   */
  getQuote(input: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
  }): Promise<SwapQuote | null>;

  /**
   * Submit the swap. `idempotencyKey` exists because a thrown call cannot be told apart
   * from a lost response: the vendor must dedupe a retry on this key and return the
   * original execution rather than trading the player's funds twice.
   *
   * `quoteId` is optional because not every vendor holds a quote server-side; where one
   * does, passing it is what binds the vendor to the price the player was shown. An
   * adapter whose vendor has expired the quote should throw rather than silently fill at
   * a worse price - the caller re-quotes and re-confirms with the player.
   */
  execute(input: {
    quoteId?: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    idempotencyKey: string;
  }): Promise<SwapExecution>;

  /**
   * Whether this vendor trades the pair at all. Consulted before a player is offered a
   * swap, so an unsupported pair never reaches a confirm screen. Optional - an adapter
   * that omits it is assumed to accept anything, and `getQuote` returning `null` is then
   * the only signal.
   */
  supportsPair?(fromCurrency: string, toCurrency: string): boolean;

  /**
   * Vendor-specific normalization of a raw webhook into a settleable event, or `null`
   * when the body is not one. Optional: a synchronous vendor that finishes inside
   * `execute` never sends one.
   */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): SwapWebhookEvent | null;

  /**
   * Targeted lookup for one swap, or `null` when the vendor has no record of it. Not
   * redundant with the webhook: a swap stuck in `processing` because its webhook was
   * lost can only be finished by asking directly.
   */
  getSwapStatus?(externalId: string): Promise<{
    status: SwapStatus;
    toAmount?: string;
    rate?: string;
  } | null>;
};

export const SWAP_ADAPTER: Token<SwapAdapter> = createToken('SWAP_ADAPTER');

/**
 * Verifies an inbound swap webhook is genuine, before anything in it is believed. Its own
 * token rather than a reuse of `PAYMENT_WEBHOOK_VERIFIER`: the swap vendor is a different
 * vendor with a different signing key, and sharing one verifier would let a request
 * signed by the payment vendor be accepted as a swap settlement. Fails closed.
 */
export type SwapWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const SWAP_WEBHOOK_VERIFIER: Token<SwapWebhookVerifier> =
  createToken('SWAP_WEBHOOK_VERIFIER');
