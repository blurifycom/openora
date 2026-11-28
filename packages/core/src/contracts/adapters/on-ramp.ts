import * as z from 'zod';
import { CurrencyTickerSchema, MoneyAmountSchema, TimestampSchema } from '../schemas/common.js';
import {
  OnRampStatusSchema,
  WalletNetworkSchema,
  type OnRampStatus,
} from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

export const OnRampFiatOptionSchema = z.object({
  code: CurrencyTickerSchema,
  minAmount: MoneyAmountSchema,
  maxAmount: MoneyAmountSchema.optional(),
});
export type OnRampFiatOption = z.infer<typeof OnRampFiatOptionSchema>;

export const OnRampOptionsSchema = z.object({
  fiats: z.array(OnRampFiatOptionSchema),
  assets: z.array(z.object({ currency: CurrencyTickerSchema, network: WalletNetworkSchema })),
});
export type OnRampOptions = z.infer<typeof OnRampOptionsSchema>;

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

export const OnRampCheckoutResultSchema = z.object({
  externalId: z.string().min(1),
  checkoutUrl: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type OnRampCheckout = z.infer<typeof OnRampCheckoutResultSchema>;

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
  getOptions(input: { country: string | null }): Promise<OnRampOptions>;

  getQuotes(input: {
    userId: string;
    fiatCurrency: string;
    fiatAmount: string;
    currency: string;
    network: string;
    country: string | null;
  }): Promise<OnRampQuote[]>;

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

  getStatus(externalId: string): Promise<OnRampStatus | null>;

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

export class OnRampRefusedError extends Error {
  readonly data: OnRampRefusedData;

  constructor(data: OnRampRefusedData) {
    super(`on-ramp purchase refused: ${data.reason}`);
    this.name = 'OnRampRefusedError';
    this.data = data;
  }
}

export class OnRampVendorUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('buying crypto is unavailable', options);
    this.name = 'OnRampVendorUnavailableError';
  }
}

export type OnRampWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const ON_RAMP_WEBHOOK_VERIFIER: Token<OnRampWebhookVerifier> = createToken(
  'ON_RAMP_WEBHOOK_VERIFIER',
);
