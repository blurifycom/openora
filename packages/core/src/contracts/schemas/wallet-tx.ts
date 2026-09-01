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
  'tip',
  'gift',
  'rain',
  'manual_credit',
  'manual_debit',
  'bet_reversal',
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
] as const;

export const WALLET_RECONCILIATION_FINDING_STATUSES = ['open', 'resolved'] as const;

export const WalletTransactionTypeSchema = z.enum(WALLET_TRANSACTION_TYPES);
export const WalletTransactionStatusSchema = z.enum(WALLET_TRANSACTION_STATUSES);
export const WalletRailSchema = z.enum(WALLET_RAILS);
export const WalletCustodySweepStatusSchema = z.enum(WALLET_CUSTODY_SWEEP_STATUSES);
export const WalletJobRunStatusSchema = z.enum(WALLET_JOB_RUN_STATUSES);
export const WalletReconciliationFindingKindSchema = z.enum(WALLET_RECONCILIATION_FINDING_KINDS);
export const WalletReconciliationFindingStatusSchema = z.enum(
  WALLET_RECONCILIATION_FINDING_STATUSES,
);

export type WalletTransactionType = z.infer<typeof WalletTransactionTypeSchema>;
export type WalletTransactionStatus = z.infer<typeof WalletTransactionStatusSchema>;
export type WalletRail = z.infer<typeof WalletRailSchema>;
export type WalletCustodySweepStatus = z.infer<typeof WalletCustodySweepStatusSchema>;
export type WalletJobRunStatus = z.infer<typeof WalletJobRunStatusSchema>;
export type WalletReconciliationFindingKind = z.infer<typeof WalletReconciliationFindingKindSchema>;
export type WalletReconciliationFindingStatus = z.infer<
  typeof WalletReconciliationFindingStatusSchema
>;
