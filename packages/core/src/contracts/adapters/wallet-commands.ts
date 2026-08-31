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
  /**
   * Which of the player's balances to take from. Omit it and the debit falls on the
   * player's active currency (`wallet.currency`), which is what every caller before
   * multi-currency swaps wanted and still gets.
   *
   * A swap is why this exists: it debits the currency being sold and credits the one
   * being bought, so it cannot let the active currency decide. `wallet_balance` has
   * always been keyed `(walletId, currency)` and the balance helpers have always taken a
   * currency - only this port pinned every move to one.
   */
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
  /**
   * Allow crediting a currency the player does not hold a balance in yet, creating the
   * `wallet_balance` row. Off by default: for every pre-existing caller a currency that
   * is not the player's own is a caller bug, and the guard that catches it is worth
   * keeping. A swap sets it, because buying an asset the player has never held is the
   * ordinary case, not a mistake.
   */
  allowNewCurrency?: boolean;
  /**
   * Allow crediting a player who has no `wallet` row at all yet, creating it in the
   * caller's transaction. Off by default: a wallet is created lazily on a player's first
   * deposit, so for every self-initiated flow a missing one really is a caller bug.
   *
   * A player-to-player transfer (gift claim, rain, donate) is the exception - the
   * recipient never chose to receive it and may never have deposited, and refusing the
   * credit would strand the sender's already-debited money. The created wallet takes the
   * credited currency as its active one, exactly as a first deposit does.
   */
  allowNewWallet?: boolean;
};

export type WalletCreditOutcome = { ok: true; newBalance: string } | { ok: false; reason: string };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
