/**
 * Ledger API v1: the one surface a casino provider bridge or the sportsbook moves real money
 * through, so neither imports wallet or round tables. In process today; the same arguments and
 * answers are what the internal HTTP route carries later, so nothing here holds a transaction.
 *
 * Every keyed op (bet, win, reverse) runs in its own transaction, keyed on
 * (`providerName`, `providerRefId`) plus a fingerprint of the request. A retry with the same key
 * and request gets the answer the first call stored (`replayed`); the same key with another
 * request is refused `fingerprint_mismatch`. A refusal is not stored: retried, it is decided
 * again. A malformed amount refuses as `invalid_amount`; any other malformed field throws.
 */
import type {
  LedgerV1BalanceArgs,
  LedgerV1BalanceOutcome,
  LedgerV1BetArgs,
  LedgerV1CloseRoundArgs,
  LedgerV1CloseRoundOutcome,
  LedgerV1MoveOutcome,
  LedgerV1ReverseArgs,
  LedgerV1WinArgs,
} from '../schemas/ledger.js';
import type { SportsbookLedger } from './sportsbook-ledger.js';
import { createToken, type Token } from './token.js';

export type LedgerApiV1 = {
  /** Takes the stake and adds it to the round, then returns it at once when `reverseRef` is set. */
  bet(args: LedgerV1BetArgs): Promise<LedgerV1MoveOutcome>;
  /** Pays the amount and adds it to the round. Never refused for the player's standing or limits. */
  win(args: LedgerV1WinArgs): Promise<LedgerV1MoveOutcome>;
  /** Returns the whole stake of a bet the API took, once, whichever key asks first. */
  reverse(args: LedgerV1ReverseArgs): Promise<LedgerV1MoveOutcome>;
  closeRound(args: LedgerV1CloseRoundArgs): Promise<LedgerV1CloseRoundOutcome>;
  /** The real balance only; bonus funds live on the grant. Read-only. */
  balance(args: LedgerV1BalanceArgs): Promise<LedgerV1BalanceOutcome>;
  /** The sportsbook ledger's own ops, unchanged. Throws when no sportsbook module is installed. */
  sportsbook: Pick<SportsbookLedger, 'reserve' | 'confirm' | 'cancel' | 'settle' | 'reopen'>;
};

export const LEDGER_API_V1: Token<LedgerApiV1> = createToken('LEDGER_API_V1');
