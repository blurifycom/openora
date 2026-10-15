/**
 * Bind a concrete `OnRampAdapter` to `ON_RAMP_ADAPTER` in an overlay; core never binds one. The
 * vendor sells crypto for fiat and delivers it on-chain to the player's own deposit address, so
 * nothing here moves a balance: the existing deposit path credits the coins when they land.
 *
 * `currency` and `network` are the platform's wallet asset ids (the asset catalog's pair); the
 * adapter maps them to the vendor's own codes. See docs/adapters/on-ramp.md for the binding guide.
 */
import { createToken, type Token } from './token.js';

/** `pending` and `processing` cover every non-terminal vendor status. */
export type OnRampStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded';

/** Amounts are decimal strings in `code`. `maxAmount` is absent when the vendor sets no ceiling. */
export type OnRampFiatOption = {
  code: string;
  minAmount: string;
  maxAmount?: string;
  paymentMethods: string[];
};

export type OnRampOptions = {
  fiats: OnRampFiatOption[];
  assets: { currency: string; network: string }[];
};

/**
 * `cryptoAmount` is what reaches the deposit address, net of `fee`, and is the only binding
 * number - `rate` is never multiplied to reach it. Amounts are decimal strings. `expiresAt` is a
 * vendor timestamp. `gatewayId` names the payment provider behind the vendor that priced it.
 */
export type OnRampQuote = {
  gatewayId: string;
  gatewayName: string;
  fiatCurrency: string;
  fiatAmount: string;
  currency: string;
  network: string;
  cryptoAmount: string;
  fee: string;
  feeCurrency: string;
  rate: string;
  paymentMethod?: string;
  expiresAt: string;
};

export type OnRampCheckout = {
  externalId: string;
  checkoutUrl: string;
};

/**
 * `walletAddress` (with `walletTag` on a memo chain) is the deposit address the order delivers
 * to. `customerId`, when the vendor echoes it, is the `userId` passed at checkout.
 */
export type OnRampWebhookEvent = {
  externalId: string;
  status: OnRampStatus;
  walletAddress: string;
  walletTag?: string;
  currency?: string;
  network?: string;
  fiatCurrency?: string;
  fiatAmount?: string;
  cryptoAmount?: string;
  customerId?: string;
};

export type OnRampAdapter = {
  /** `country` is ISO 3166-1 alpha-2, or `null` when the platform could not resolve one. */
  getOptions(input: { country: string | null }): Promise<OnRampOptions>;

  /** Ranked best first. An empty list means no gateway will sell this pair for this amount. */
  getQuotes(input: {
    userId: string;
    fiatCurrency: string;
    fiatAmount: string;
    currency: string;
    network: string;
    paymentMethod?: string;
    country: string | null;
  }): Promise<OnRampQuote[]>;

  /**
   * The vendor must dedupe a retry on `idempotencyKey` and return the original checkout rather
   * than opening a second order. `walletAddress` is always one the platform issued to `userId`.
   * Only the player's id goes to the vendor - never an email or a name.
   */
  createCheckout(input: {
    userId: string;
    gatewayId: string;
    fiatCurrency: string;
    fiatAmount: string;
    currency: string;
    network: string;
    paymentMethod?: string;
    walletAddress: string;
    walletTag?: string;
    country: string | null;
    idempotencyKey: string;
  }): Promise<OnRampCheckout>;

  /** Returns `null` when the body is not an order status update. Runs only after verification. */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): OnRampWebhookEvent | null;
};

export const ON_RAMP_ADAPTER: Token<OnRampAdapter> = createToken('ON_RAMP_ADAPTER');

export type OnRampRefusalReason =
  | 'fiat_unsupported'
  | 'below_minimum'
  | 'above_maximum'
  | 'no_quote';

export type OnRampRefusedData =
  | { reason: 'below_minimum'; fiatCurrency: string; minAmount: string }
  | { reason: 'above_maximum'; fiatCurrency: string; maxAmount: string }
  | { reason: 'fiat_unsupported' | 'no_quote' };

/**
 * A purchase the vendor will not take as asked. The router answers BAD_REQUEST with `data`;
 * an adapter may throw it too, eg from `createCheckout` when the gateway withdrew its quote.
 */
export class OnRampRefusedError extends Error {
  readonly data: OnRampRefusedData;

  constructor(data: OnRampRefusedData, message: string) {
    super(message);
    this.name = 'OnRampRefusedError';
    this.data = data;
  }
}

/** Its own token, not a reuse of `PAYMENT_WEBHOOK_VERIFIER`: the on-ramp vendor signs with its own key. Fails closed. */
export type OnRampWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const ON_RAMP_WEBHOOK_VERIFIER: Token<OnRampWebhookVerifier> = createToken(
  'ON_RAMP_WEBHOOK_VERIFIER',
);
