import type { WalletDepositStatusEventStatus } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

export type PaymentWebhookEvent =
  | {
      kind: 'deposit';
      address: string;
      network?: string;
      tag?: string;
      amount: string;
      currency: string;
      txHash: string;
      externalId: string;
      sourceAddress?: string;
    }
  | {
      kind: 'deposit_status';
      status: Exclude<WalletDepositStatusEventStatus, 'below_minimum'>;
      address: string;
      network?: string;
      tag?: string;
      amount: string;
      currency: string;
      txHash?: string;
      externalId: string;
      vendorStatus?: string;
    }
  | {
      kind: 'withdrawal';
      externalId: string;
      status: 'processing' | 'completed' | 'failed';
      txHash?: string;
    };

export class PaymentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRejectedError';
  }
}

export type CustodyBalance = {
  userId: string;
  currency: string;
  network: string;
  amount: string;
  estimatedFee: string;
};

export const DEFAULT_PAYMENT_PROVIDER = 'default';

export type PaymentProvider = {
  adapter: PaymentAdapter;
  webhookVerifier: PaymentWebhookVerifier;
};

export type PaymentProviderRegistry = {
  get(providerName: string): PaymentProvider | null;
  names(): readonly string[];
};

export type PaymentAdapter = {
  processDeposit(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  processWithdrawal(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  withdrawalDecimals?(currency: string, network: string): number | null;

  issueDepositAddress?(
    userId: string,
    currency: string,
    network?: string,
  ): Promise<{ address: string; tag?: string }>;

  whitelistWithdrawalAddress?(input: {
    userId: string;
    currency: string;
    network: string;
    address: string;
    destinationTag?: string;
  }): Promise<{ providerWalletId: string }>;

  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): PaymentWebhookEvent | null;

  supportsAsset?(currency: string, network: string): boolean;

  listSweepableBalances?(): Promise<CustodyBalance[]>;

  sweepToPool?(
    balance: CustodyBalance,
    opts: { idempotencyKey: string; treasuryRef?: string },
  ): Promise<{ externalId: string; poolRef?: string }>;

  getPoolBalance?(currency: string, network: string): Promise<string>;

  listTransactions?(range: { since: Date; until: Date }): Promise<PaymentWebhookEvent[]>;

  getWithdrawalStatus?(externalId: string): Promise<{
    status: 'processing' | 'completed' | 'failed';
    txHash?: string;
  } | null>;

  findWithdrawalByReference?(transactionId: string): Promise<{
    externalId: string;
    status: 'processing' | 'completed' | 'failed';
    txHash?: string;
  } | null>;
};

export const PAYMENT_ADAPTER: Token<PaymentAdapter> = createToken('PAYMENT_ADAPTER');

export type PaymentWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const PAYMENT_WEBHOOK_VERIFIER: Token<PaymentWebhookVerifier> = createToken(
  'PAYMENT_WEBHOOK_VERIFIER',
);

export const PAYMENT_PROVIDERS: Token<PaymentProviderRegistry> = createToken('PAYMENT_PROVIDERS');
