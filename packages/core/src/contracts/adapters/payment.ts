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

/**
 * A balance sitting in a per-player custody container that is not yet in the pooled
 * account withdrawals are paid from. Produced by `PaymentAdapter.listSweepableBalances`
 * and handed back to `sweepToPool` unchanged.
 */
export type CustodyBalance = {
  userId: string;
  currency: string;
  network: string;
  amount: string;
  /** Current network cost to move it, same units as `amount`. */
  estimatedFee: string;
};

/**
 * Name of the single default `PaymentAdapter`/`PaymentWebhookVerifier` binding, wrapped
 * as one `PaymentProviderRegistry` entry so an operator with one vendor changes nothing.
 */
export const DEFAULT_PAYMENT_PROVIDER = 'default';

/** One named vendor binding: the adapter it settles through and the verifier for its webhooks. */
export type PaymentProvider = {
  adapter: PaymentAdapter;
  webhookVerifier: PaymentWebhookVerifier;
};

/**
 * Looks up a named vendor's adapter/verifier pair. `wallet_asset.providerName` is the
 * key; a webhook route resolves both the verifier AND the adapter from the SAME entry so
 * a request can never be verified against one vendor's key and parsed by another's
 * format (signature confusion).
 *
 * Core only looks a name up here - it never discovers or enumerates vendors itself. The
 * operator composes this map in their own plugin because `Container.register` is
 * last-wins: two overlays each binding the single `PAYMENT_ADAPTER`/`PAYMENT_WEBHOOK_VERIFIER`
 * tokens would clobber each other, so running a fiat PSP and a crypto custodian at once
 * needs an operator-owned map from provider name to pair, not a second core-discovered
 * binding slot.
 */
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
   * Register a player's payout address with the vendor and return the id a withdrawal names as
   * its destination. Implemented by a custody vendor that requires destinations to be approved
   * before funds can reach them; a synchronous PSP, which pays to an address it is handed,
   * omits it and the wallet module stores no provider id.
   *
   * Called on the address-book write path rather than at payout time on purpose: approval can
   * need a human quorum, which must not sit inside a withdrawal that is already holding a
   * player's funds. Implementations must be idempotent on
   * (userId, currency, network, address, destinationTag) - a retried registration has to return
   * the original id instead of creating a second destination that then needs its own approval.
   *
   * `destinationTag` is part of the destination, not a detail of it: on a tag/memo chain one
   * address serves many accounts and the tag picks which, so two tags on the same address are
   * two different beneficiaries and must whitelist as two different destinations.
   */
  whitelistWithdrawalAddress?(input: {
    userId: string;
    currency: string;
    network: string;
    address: string;
    destinationTag?: string;
  }): Promise<{ providerWalletId: string }>;

  /**
   * Vendor-specific normalization of a raw webhook into a reconcilable event, or
   * null when the body is not one (eg an unrecognized event type). Optional -
   * `MockPaymentAdapter` omits it; an address-based/async vendor overlay implements it.
   */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): PaymentWebhookEvent | null;

  /**
   * Whether this adapter can actually serve the given asset. The asset catalog is
   * operator-editable at runtime, so an admin can name a (currency, network) pair the
   * bound vendor has never heard of; the catalog's write path calls this first and
   * rejects rather than letting the pair reach a player's deposit screen. Optional -
   * an adapter that omits it is assumed to accept anything the operator configures.
   */
  supportsAsset?(currency: string, network: string): boolean;

  /**
   * Per-player balances the vendor holds that are not yet in the pooled account.
   * Only meaningful for a custody vendor whose per-player deposit containers are
   * distinct from the account withdrawals are paid out of - a synchronous PSP, which
   * never holds a per-player balance, omits it.
   */
  listSweepableBalances?(): Promise<CustodyBalance[]>;

  /**
   * Move one player's balance into the pooled account. Implemented alongside
   * `listSweepableBalances`; the caller owns the policy (dust floor, fee thresholds)
   * and this only performs the transfer it is handed.
   *
   * `idempotencyKey` exists because a thrown call cannot be distinguished from a lost
   * response - the vendor must dedupe the retry on this key rather than double-move
   * funds. `poolRef` is an opaque vendor-side identifier for the destination pool,
   * recorded so the ledger can evidence that player funds landed in the player pool and
   * not an operator account - a regulator asks this.
   */
  sweepToPool?(
    balance: CustodyBalance,
    opts: { idempotencyKey: string; treasuryRef?: string },
  ): Promise<{ externalId: string; poolRef?: string }>;

  /**
   * Balance currently in the pooled account for this asset. Consulted only when a sweep
   * is blocked by the fee ceiling, to decide whether paying a high fee beats running the
   * pool dry. Omit it and the ceiling is absolute.
   */
  getPoolBalance?(currency: string, network: string): Promise<string>;

  /**
   * Vendor transactions in a window, normalized into the same events `parseWebhook`
   * produces - reconciliation is that same normalization, polled instead of pushed.
   * Implemented by a vendor whose ledger can be listed after the fact; a PSP that only
   * pushes webhooks omits it.
   */
  listTransactions?(range: { since: Date; until: Date }): Promise<PaymentWebhookEvent[]>;

  /**
   * Targeted status lookup for a single withdrawal, or null when the vendor has no
   * record of it. Not redundant with `listTransactions`: a withdrawal stuck in
   * `processing` for days falls outside any sane reconciliation window, so finalizing
   * it needs a direct lookup by `externalId`.
   */
  getWithdrawalStatus?(externalId: string): Promise<{
    status: 'processing' | 'completed' | 'failed';
    txHash?: string;
  } | null>;
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

export const PAYMENT_PROVIDERS: Token<PaymentProviderRegistry> = createToken('PAYMENT_PROVIDERS');
