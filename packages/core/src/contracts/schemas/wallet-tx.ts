// Canonical wallet transaction enums. Single source of truth, kept in the
// isomorphic contracts zone so both the wallet domain and a sibling domain
// (eg admin-console) can reference them without a cross-domain import. These
// MUST stay in lockstep with the Drizzle pgEnums in wallet/schema/index.ts.
import * as z from 'zod';

// The value tuples are the single source of truth: `z.enum` derives the contract
// here and the Drizzle `pgEnum`s in wallet/schema derive the DB enum from the same
// tuple, so the two can never drift.
export const WALLET_TRANSACTION_TYPES = [
  'deposit',
  'withdrawal',
  'bet',
  'win',
  'loss',
  'bonus',
  /** A plain cash transfer between players, credited as withdrawable balance with no wagering; for a player-to-player donation use `donation`. */
  'tip',
  'gift',
  'rain',
  'manual_credit',
  'manual_debit',
  'swap_out',
  'swap_in',
  'bet_reversal',
  /** Rank rakeback and a streak's cash reward: an operator-funded real-money credit, no wagering requirement. */
  'cashback',
  /** Takes back a settled payout after the provider reopens the bet; never more than the balance holds. */
  'win_reversal',
  /** The sender's cash leg of a player-to-player donation; the recipient's credit is a wagered bonus grant. */
  'donation',
] as const;

export const WALLET_TRANSACTION_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'rejected',
  // Compliance hold for AML/SAR review (drives the back-office review queue via the
  // reviewedBy/reviewReason columns); `cancelled` is a player/ops-reversed withdrawal.
  'on_hold',
  'cancelled',
  // An on-chain deposit that was held and never credited, sent back to the player on chain.
  'refunded',
] as const;

// Settlement category, not a vendor: the concrete provider (a custody/MPC vendor, a
// PSP, ...) is carried separately in the transaction's providerName. `crypto` covers
// on-chain rails, `fiat` covers card/bank/PSP rails.
export const WALLET_RAILS = ['crypto', 'fiat'] as const;

// A vendor-side internal transfer of pooled/custody funds, never a player balance
// change. `unknown` is load-bearing: a thrown sweep attempt cannot tell "vendor never
// saw it" from "vendor accepted it and the response was lost", so the row parks in
// `unknown` and KEEPS holding the in-flight guard rather than risk a double transfer.
export const WALLET_CUSTODY_SWEEP_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'unknown',
] as const;

export const WALLET_JOB_RUN_STATUSES = [
  'running',
  'completed',
  'skipped',
  'failed',
  'abandoned',
] as const;

export const WALLET_RECONCILIATION_FINDING_KINDS = [
  'missing_deposit',
  'unattributed_deposit',
  'amount_mismatch',
  'currency_mismatch',
  'status_mismatch',
  'unknown_at_provider',
  'unconfigured_asset',
  'stuck_sweep',
  'rg_limit_breach',
  'stuck_swap',
  'held_deposit',
  'below_minimum_deposit',
  // A wallet balance its own ledger does not add up to.
  'ledger_invariant_breach',
  // A wallet the ledger invariant cannot check: its history holds rows nothing prices and no
  // baseline covers them.
  'ledger_invariant_unchecked',
  // A withdrawal older than its state allows, one kind per saga state (ADR-0057).
  'stuck_withdrawal_requested',
  'stuck_withdrawal_approved',
  'stuck_withdrawal_processing',
] as const;

export const WALLET_RECONCILIATION_FINDING_STATUSES = ['open', 'resolved'] as const;

export const WALLET_DEPOSIT_STATUS_EVENT_STATUSES = [
  'detected',
  'failed',
  'below_minimum',
] as const;

// A fiat on-ramp order as its vendor reports it. `pending` and `processing` cover every
// non-terminal vendor status; the rest are terminal.
export const ON_RAMP_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'refunded',
] as const;

export const WalletTransactionTypeSchema = z.enum(WALLET_TRANSACTION_TYPES);
export const WalletTransactionStatusSchema = z.enum(WALLET_TRANSACTION_STATUSES);
export const WalletRailSchema = z.enum(WALLET_RAILS);
export const WalletCustodySweepStatusSchema = z.enum(WALLET_CUSTODY_SWEEP_STATUSES);
export const WalletJobRunStatusSchema = z.enum(WALLET_JOB_RUN_STATUSES);
export const WalletReconciliationFindingKindSchema = z.enum(WALLET_RECONCILIATION_FINDING_KINDS);
export const WalletReconciliationFindingStatusSchema = z.enum(
  WALLET_RECONCILIATION_FINDING_STATUSES,
);
export const WalletDepositStatusEventStatusSchema = z.enum(WALLET_DEPOSIT_STATUS_EVENT_STATUSES);
export const OnRampStatusSchema = z.enum(ON_RAMP_STATUSES);

// A currency does not identify a chain: USDT settles on ERC20, TRC20 and BEP20 with
// different addresses, fees and minimums. Free-form rather than an enum because each
// vendor spells chains its own way (ERC20 vs ETHEREUM vs eth-mainnet).
export const WalletNetworkSchema = z.string().trim().min(1).max(32);

export type WalletTransactionType = z.infer<typeof WalletTransactionTypeSchema>;
export type WalletTransactionStatus = z.infer<typeof WalletTransactionStatusSchema>;
export type WalletRail = z.infer<typeof WalletRailSchema>;
export type WalletCustodySweepStatus = z.infer<typeof WalletCustodySweepStatusSchema>;
export type WalletJobRunStatus = z.infer<typeof WalletJobRunStatusSchema>;
export type WalletReconciliationFindingKind = z.infer<typeof WalletReconciliationFindingKindSchema>;
export type WalletReconciliationFindingStatus = z.infer<
  typeof WalletReconciliationFindingStatusSchema
>;
export type WalletDepositStatusEventStatus = z.infer<typeof WalletDepositStatusEventStatusSchema>;
export type OnRampStatus = z.infer<typeof OnRampStatusSchema>;

export const DEFAULT_CRYPTO_CURRENCIES = ['BTC', 'ETH', 'USDT', 'USDC'] as const;

export function railFor(currency: string, cryptoCurrencies?: readonly string[]): WalletRail {
  const set = new Set((cryptoCurrencies ?? DEFAULT_CRYPTO_CURRENCIES).map((c) => c.toUpperCase()));
  return set.has(currency.toUpperCase()) ? 'crypto' : 'fiat';
}
