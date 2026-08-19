/**
 * Payment seam. A PSP (card/bank/e-wallet) or a custody/address-issuing crypto vendor
 * implements PaymentAdapter; bind a concrete adapter to PAYMENT_ADAPTER in the wallet
 * module's plugin.ts. See docs/adapters/payment.md for the full binding guide.
 */
import { createToken, type Token } from './token.js';

/**
 * Normalized shape of an inbound payment-vendor webhook, produced by a
 * `PaymentAdapter.parseWebhook` implementation. A `deposit` event reports funds that
 * arrived at a previously-issued address (see `issueDepositAddress`); a `withdrawal`
 * event reports a status transition for a withdrawal already sent to the vendor via
 * `processWithdrawal`. `externalId` is the vendor's reference id for the underlying
 * settlement - the dedup key the wallet module reconciles against.
 *
 * A deposit carries `network` because an address does not identify a chain: an EVM vault
 * hands out one address that is shared across every EVM chain AND every token on them, so
 * `address` alone maps to many issued rows. Omitting it falls back to address-only lookup,
 * which is safe only for a vendor that issues a distinct address per currency.
 */
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
    }
  | {
      kind: 'withdrawal';
      externalId: string;
      status: 'processing' | 'completed' | 'failed';
      txHash?: string;
    };

export type PaymentAdapter = {
  processDeposit(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  /**
   * Send a withdrawal to the vendor. For a synchronous PSP the returned `status` is
   * already terminal (`'completed'`/`'failed'`) and the caller finalizes the
   * transaction immediately. For an async vendor (eg a custody/MPC rail that
   * broadcasts on-chain) the returned `status` may be anything else (eg
   * `'processing'`/`'submitted'`) - the caller then leaves the transaction in
   * `processing` and relies on the webhook path (`parseWebhook` -> reconciliation)
   * for the eventual terminal transition.
   */
  processWithdrawal(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  /**
   * Issue (or return) a deposit address for this user/asset. Only implemented by
   * address-based deposit vendors (eg a custody/MPC crypto rail) - a synchronous PSP
   * or `MockPaymentAdapter` omits it. The wallet module persists the returned address
   * so re-requesting the same (userId, currency, network) is idempotent without a second
   * vendor call.
   */
  issueDepositAddress?(
    userId: string,
    currency: string,
    network?: string,
  ): Promise<{ address: string; tag?: string }>;

  /**
   * Vendor-specific normalization of a raw webhook into a reconcilable event, or
   * null when the body is not one (eg an unrecognized event type). Optional -
   * `MockPaymentAdapter` omits it; an address-based/async vendor overlay implements it.
   */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): PaymentWebhookEvent | null;
};

export const PAYMENT_ADAPTER: Token<PaymentAdapter> = createToken('PAYMENT_ADAPTER');

/**
 * Verifies the public payment-vendor webhook is genuine. The default impl
 * (`HmacPaymentWebhookVerifier`) recomputes an HMAC-SHA256 over the raw request body
 * and constant-time compares it against the `x-payment-signature` header; a vendor
 * overlay rebinds it. Fails closed when the secret is unset, the signature header is
 * absent, or the raw body was not captured.
 */
export type PaymentWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const PAYMENT_WEBHOOK_VERIFIER: Token<PaymentWebhookVerifier> = createToken(
  'PAYMENT_WEBHOOK_VERIFIER',
);
