/**
 * Wallet command port: another module moves money on the caller's own `tx`, so the move is
 * atomic with the caller's writes yet the modules stay decoupled and independently extractable. ADR-0017.
 */
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

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
};

export type WalletDebitOutcome =
  | {
      ok: true;
      newBalance: string;
      currency: string;
      completedBonusCredits?: Array<{ id: string; currency: string; creditedAmount: string }>;
      /** The `wallet_transaction` row id, present only when this call actually moved the
       * balance - absent for the informational `loss` row and a replayed `providerRef`.
       * The caller emits `wallet.balance.changed` with it once its own transaction commits;
       * this port never emits it itself (see WalletCommandsService). */
      transactionId?: string;
    }
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

export type WalletCreditOutcome =
  | { ok: true; newBalance: string; transactionId?: string }
  | { ok: false; reason: string };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
