/**
 * Bonus grant ledger read port: a player's grants as rows of their wallet transaction history.
 * A bonus, a chat gift or a rain drop the player received lands on a `promo_grant`, never on the
 * real-money `wallet_transaction` ledger, so without this the player's history silently leaves
 * them out. The bonus module owns the projection (which source is which type, which grant status
 * is which transaction status); the wallet only unions it with its own rows.
 */
import { createToken, type Token } from './token.js';

export type BonusGrantLedgerReader = {
  /**
   * A SELECT over the player's grants returning exactly these columns, in this order:
   * `id uuid, type text, amount numeric, currency text, status text, created_at timestamptz`.
   * `type` is a `WalletTransactionType` and `status` a `WalletTransactionStatus`. The wallet
   * UNION ALLs it with its own ledger so filters, sort and paging run in one statement rather
   * than over two merged pages. Typed `unknown` because this contracts-zone port cannot import
   * drizzle's `SQL` - the same convention as the `tx: unknown` command ports.
   */
  ledgerRowsQuery(userId: string): unknown;
};

export const BONUS_GRANT_LEDGER: Token<BonusGrantLedgerReader> = createToken('BONUS_GRANT_LEDGER');
