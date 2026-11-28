import * as z from 'zod';

export const WALLET_TRANSACTION_TYPES = [
  'deposit',
  'withdrawal',
  'bet',
  'win',
  'loss',
  'bonus',
  'gift',
  'rain',
  'manual_credit',
  'manual_debit',
  'swap_out',
  'swap_in',
  'bet_reversal',
  'cashback',
  'win_reversal',
  'donation',
  'referral_reward',
] as const;

export const WALLET_TRANSACTION_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'rejected',
  'on_hold',
  'cancelled',
  'refunded',
] as const;

export const WALLET_RAILS = ['crypto', 'fiat'] as const;

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
  'ledger_invariant_breach',
  'ledger_invariant_unchecked',
  'stuck_withdrawal_requested',
  'stuck_withdrawal_approved',
  'stuck_withdrawal_processing',
  'ledger_request_mismatch',
  'ledger_unrequested_transaction',
  'play_eligibility_drift',
  'rg_limits_drift',
  'outbox_relay_lag',
  'event_dead_letters',
] as const;

export const WALLET_RECONCILIATION_FINDING_STATUSES = ['open', 'resolved'] as const;

export const WALLET_DEPOSIT_STATUS_EVENT_STATUSES = [
  'detected',
  'failed',
  'below_minimum',
] as const;

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
