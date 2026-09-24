/**
 * Wallet command port: another module moves money on the caller's own `tx`, so the move is
 * atomic with the caller's writes yet the modules stay decoupled and independently extractable. ADR-0017.
 */
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';

export type WalletProviderRef = {
  providerName: string;
  providerRefId: string;
  externalRoundId?: string;
  responseSnapshot?: unknown;
};

export type WalletDebitArgs = {
  userId: string;
  amount: string;
  type: WalletTransactionType;
  /** Which of the player's balances to take from. Omit it and the debit falls on the player's active currency (`wallet.currency`). */
  currency?: string;
  providerRef?: WalletProviderRef;
  /**
   * What the bet was placed on, when this debit is one. The bonus engine resolves a wagering
   * weight from it and gamification counts qualifying wagers off it, so a provider seam that
   * drops it silently stops both. Absent for a debit that is not a bet (a withdrawal, a swap).
   */
  context?: WagerContext;
};

/**
 * `moved: true` means this call changed the balance and wrote the `wallet_transaction` row
 * `transactionId` names; the caller emits `wallet.balance.changed` with it once its own
 * transaction commits, since this port never emits it itself (see WalletCommandsService).
 * `moved: false` is a success that moved nothing: the informational `loss` row or a
 * replayed `providerRef`.
 */
export type WalletDebitOutcome =
  | {
      ok: true;
      moved: true;
      transactionId: string;
      /** Real balance after the debit. Bonus funds are not part of it - they live on the grant. */
      newBalance: string;
      currency: string;
      /** Part of the stake paid out of bonus funds, as a decimal string. Absent when none was. */
      bonusSpent?: string;
      /** Bonus funds left on the grant the bet was attributed to. */
      bonusBalance?: string;
      /** The grant this debit pushed over its requirement, and what it released into the real balance. */
      completed?: { grantId: string; convertedAmount: string };
    }
  | { ok: true; moved: false; newBalance: string; currency: string }
  /** `available` is the real balance plus whatever bonus funds could have covered the rest. */
  | { ok: false; available: string };

export type WalletCreditArgs = {
  userId: string;
  amount: string;
  currency: string;
  type: WalletTransactionType;
  /** Allow crediting a currency the player does not hold a balance in yet, creating the `wallet_balance` row. Off by default. */
  allowNewCurrency?: boolean;
  /** Allow crediting a player who has no `wallet` row at all yet, creating it in the caller's transaction. Off by default. */
  allowNewWallet?: boolean;
  providerRef?: WalletProviderRef;
};

/** `moved` as on `WalletDebitOutcome`; `moved: false` is a replayed `providerRef`. */
export type WalletCreditOutcome =
  | { ok: true; moved: true; transactionId: string; newBalance: string }
  | { ok: true; moved: false; newBalance: string }
  | { ok: false; reason: string };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
