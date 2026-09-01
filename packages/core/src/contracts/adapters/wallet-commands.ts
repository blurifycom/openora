/**
 * Wallet command port: another module moves money on the caller's own `tx`, so the move is
 * atomic with the caller's writes yet the modules stay decoupled and independently extractable. ADR-0017.
 */
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

export type WalletDebitArgs = {
  userId: string;
  amount: string;
  type: WalletTransactionType;
  /** Which of the player's balances to take from. Omit it and the debit falls on the player's active currency (`wallet.currency`). */
  currency?: string;
};

export type WalletDebitOutcome =
  | {
      ok: true;
      newBalance: string;
      currency: string;
      completedBonusCredits?: Array<{ id: string; currency: string; creditedAmount: string }>;
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
};

export type WalletCreditOutcome = { ok: true; newBalance: string } | { ok: false; reason: string };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
