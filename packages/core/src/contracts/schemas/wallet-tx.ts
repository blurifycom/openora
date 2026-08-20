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

// Settlement category, not a vendor: the concrete provider (Fireblocks, a PSP, ...)
// is carried separately in the transaction's providerName. `crypto` covers on-chain
// rails, `fiat` covers card/bank/PSP rails.
export const WALLET_RAILS = ['crypto', 'fiat'] as const;

export const WalletTransactionTypeSchema = z.enum(WALLET_TRANSACTION_TYPES);
export const WalletTransactionStatusSchema = z.enum(WALLET_TRANSACTION_STATUSES);
export const WalletRailSchema = z.enum(WALLET_RAILS);

export type WalletTransactionType = z.infer<typeof WalletTransactionTypeSchema>;
export type WalletTransactionStatus = z.infer<typeof WalletTransactionStatusSchema>;
export type WalletRail = z.infer<typeof WalletRailSchema>;
