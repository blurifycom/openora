/**
 * Bind a concrete `OnRampAdapter` to `ON_RAMP_ADAPTER` in an overlay; core never binds one. The
 * vendor sells crypto for fiat on its own hosted checkout - the player picks the payment gateway
 * and method there - and delivers on-chain to the player's own deposit address, so nothing here
 * moves a balance: the existing deposit path credits the coins when they land.
 *
 * `currency` and `network` are the platform's wallet asset ids (the asset catalog's pair); the
 * adapter maps them to the vendor's own codes. See docs/adapters/on-ramp.md for the binding guide.
 */
import * as z from 'zod';
import { CurrencyTickerSchema, MoneyAmountSchema, TimestampSchema } from '../schemas/common.js';
import {
  OnRampStatusSchema,
  WalletNetworkSchema,
  type OnRampStatus,
} from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

/** Amounts are decimal strings in `code`. `maxAmount` is absent when the vendor sets no ceiling. */
export const OnRampFiatOptionSchema = z.object({
  code: CurrencyTickerSchema,
  minAmount: MoneyAmountSchema,
  maxAmount: MoneyAmountSchema.optional(),
});
export type OnRampFiatOption = z.infer<typeof OnRampFiatOptionSchema>;

/**
 * Core validates the vendor's answer against this schema and refuses as unavailable on anything
 * else. The route answers only those `assets` the platform takes deposits in.
 */
export const OnRampOptionsSchema = z.object({
  fiats: z.array(OnRampFiatOptionSchema),
  assets: z.array(z.object({ currency: CurrencyTickerSchema, network: WalletNetworkSchema })),
});
export type OnRampOptions = z.infer<typeof OnRampOptionsSchema>;

/**
 * An estimate only: the price is fixed on the vendor's checkout page, not here. `cryptoAmount`
 * is what would reach the deposit address, net of `fee`. Amounts are decimal strings.
 * `expiresAt` is a UTC ISO timestamp. `gatewayId` names the payment provider behind the vendor
 * that priced it. Core validates the vendor's answer against this schema.
 */
export const OnRampQuoteSchema = z.object({
  gatewayId: z.string(),
  gatewayName: z.string(),
  fiatCurrency: CurrencyTickerSchema,
  fiatAmount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  network: WalletNetworkSchema,
  cryptoAmount: MoneyAmountSchema,
  fee: MoneyAmountSchema,
  feeCurrency: CurrencyTickerSchema,
  rate: MoneyAmountSchema,
  expiresAt: TimestampSchema,
});
export type OnRampQuote = z.infer<typeof OnRampQuoteSchema>;

/**
 * `checkoutUrl` must be https: the client navigates to it. `expiresAt` is the ISO timestamp
 * after which the vendor no longer takes payment on it; until then the order counts toward the
 * player's deposit limit. Core validates the result and fails the order on anything else.
 */
export const OnRampCheckoutResultSchema = z.object({
  externalId: z.string().min(1),
  checkoutUrl: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type OnRampCheckout = z.infer<typeof OnRampCheckoutResultSchema>;

/**
 * `purchaseId` is the id core passed to `createCheckout`, echoed back by the vendor; core falls
 * back to `externalId` when it is absent. `walletAddress` (with `walletTag` on a memo chain) is
 * the address the order delivers to, and `externalCustomerId` the `userId` passed at checkout,
 * when the vendor echoes them. `gatewayId` is the payment provider the player chose. Core
 * validates a parsed event against this schema and ignores one that fails it.
 */
export const OnRampWebhookEventSchema = z.object({
  purchaseId: z.string().exactOptional(),
  externalId: z.string().min(1),
  status: OnRampStatusSchema,
  walletAddress: z.string().min(1).exactOptional(),
  walletTag: z.string().exactOptional(),
  externalCustomerId: z.string().exactOptional(),
  cryptoAmount: MoneyAmountSchema.exactOptional(),
  txHash: z.string().exactOptional(),
  gatewayId: z.string().exactOptional(),
});
export type OnRampWebhookEvent = z.infer<typeof OnRampWebhookEventSchema>;

export type OnRampAdapter = {
  /** `country` is ISO 3166-1 alpha-2, or `null` when the platform could not resolve one. */
  getOptions(input: { country: string | null }): Promise<OnRampOptions>;

  /** Estimates, ranked best first. May be empty: the checkout page still prices the order. */
  getQuotes(input: {
    userId: string;
    fiatCurrency: string;
    fiatAmount: string;
    currency: string;
    network: string;
    country: string | null;
  }): Promise<OnRampQuote[]>;

  /**
   * Opens a hosted checkout. `purchaseId` is core's order id; the vendor echoes it on webhooks.
   * The vendor must dedupe a retry on `idempotencyKey` and return the original checkout rather
   * than opening a second order; the key is already scoped to the player. `walletAddress` is
   * always one the platform issued to `userId`. Only the player's id goes to the vendor - never
   * an email or a name.
   */
  createCheckout(input: {
    userId: string;
    purchaseId: string;
    fiatCurrency: string;
    fiatAmount: string;
    currency: string;
    network: string;
    walletAddress: string;
    walletTag?: string;
    country: string | null;
    idempotencyKey: string;
  }): Promise<OnRampCheckout>;

  /** The order's current status, or `null` when the vendor does not know `externalId`. */
  getStatus(externalId: string): Promise<OnRampStatus | null>;

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
  | 'below_deposit_minimum';

export type OnRampRefusedData =
  | { reason: 'below_minimum'; fiatCurrency: string; minAmount: string }
  | { reason: 'above_maximum'; fiatCurrency: string; maxAmount: string }
  | { reason: 'below_deposit_minimum'; currency: string; network: string; minDeposit: string }
  | { reason: 'fiat_unsupported' };

/**
 * A purchase the vendor will not take as asked. The router answers BAD_REQUEST with `data`.
 * The message is built from `data` alone, so nothing a vendor said reaches a client.
 */
export class OnRampRefusedError extends Error {
  readonly data: OnRampRefusedData;

  constructor(data: OnRampRefusedData) {
    super(`on-ramp purchase refused: ${data.reason}`);
    this.name = 'OnRampRefusedError';
    this.data = data;
  }
}

/**
 * Thrown by an adapter when the vendor times out, rate-limits or answers 5xx. The router answers
 * the same CONFLICT as an unbound vendor, with a fixed message; pass the vendor's error as
 * `cause` for the logs, never as the message.
 */
export class OnRampVendorUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('buying crypto is unavailable', options);
    this.name = 'OnRampVendorUnavailableError';
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
