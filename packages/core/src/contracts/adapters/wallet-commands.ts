// Wallet command port: another module moves money on the caller's own `tx`, so the move is
// atomic with the caller's writes yet the modules stay decoupled and independently extractable. ADR-0017.
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';

export type WalletDebitArgs = {
  userId: string;
  amount: number;
  type: WalletTransactionType;
};

export type WalletDebitOutcome =
  | { ok: true; newBalance: number }
  | { ok: false; available: number };

export type WalletCreditArgs = {
  userId: string;
  amount: number;
  type: WalletTransactionType;
};

export type WalletCreditOutcome = { ok: true; newBalance: number } | { ok: false; reason: string };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
