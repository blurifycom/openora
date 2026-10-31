/**
 * Sportsbook ledger port: the operator's provider overlay turns each verified provider callback
 * into one of these domain operations. Every call opens and commits its own transaction under the
 * betting module's lock order, so a caller never holds a lock across its own network work.
 */
import type {
  SportsbookBetStatus,
  SportsbookCancelArgs,
  SportsbookConfirmArgs,
  SportsbookRefusalReason,
  SportsbookReopenArgs,
  SportsbookReserveArgs,
  SportsbookSessionArgs,
  SportsbookSettleArgs,
} from '../schemas/sportsbook.js';
import type { PlayRefusal } from './play-eligibility.js';
import { createToken, type Token } from './token.js';

/**
 * `replayed` answers a provider transaction id the ledger already applied with the same request,
 * with the answer that request first got, even when the bet moved on since: nothing moved again.
 * The fields are null only for a cancel of a bet core never saw, which leaves a tombstone with no
 * bet and no player.
 */
export type SportsbookLedgerApplied = {
  status: 'applied' | 'replayed';
  betId: string | null;
  betStatus: SportsbookBetStatus | null;
  betVersion: number | null;
  /** The player's real balance in the bet currency once the operation committed. */
  balance: string | null;
  currency: string | null;
};

/**
 * Nothing was written for a refusal except a finding for `fingerprint_mismatch`, `invalid_amount`,
 * and an `illegal_transition` that is not a late reserve after a tombstone. A malformed amount
 * refuses as `invalid_amount` and a malformed session id as `session_invalid`; any other malformed
 * field is the overlay's bug and throws.
 */
export type SportsbookLedgerRefused = {
  status: 'refused';
  reason: SportsbookRefusalReason;
};

export type SportsbookLedgerOutcome = SportsbookLedgerApplied | SportsbookLedgerRefused;

export type SportsbookSessionOutcome =
  | {
      status: 'ok';
      userId: string;
      currency: string;
      countryCode: string;
      expiresAt: string;
      balance: string;
      /** The player is restricted from sportsbook: they may browse, and every reserve refuses. */
      browseOnly: boolean;
    }
  | { status: 'refused'; reason: 'session_invalid' | PlayRefusal };

/** Idempotent on the provider transaction id, which may not start with `core-align:`: core's own ids. */
export type SportsbookLedger = {
  /** Resolves a live session the provider presents back: who plays, in which currency, with what balance. Refused, naming why, once the player may not play. Read-only. */
  session(args: SportsbookSessionArgs): Promise<SportsbookSessionOutcome>;
  /** Debits the cash stake, nothing for a promotion-paid stake, and records the bet as reserved. Refused for a bet core already holds, and once the bet was cancelled before core saw it. */
  reserve(args: SportsbookReserveArgs): Promise<SportsbookLedgerOutcome>;
  /**
   * The provider accepted the reserved bet, at changed odds when it passes the accepted terms.
   * Moves no money. Terms that come without their pair, break the currency decimals, pay less than
   * the cash stake, change legs other than by their odds, with decimal odds move the payout other
   * than the way the odds product moved, or change the promotion part while the odds held refuse as
   * `invalid_amount`.
   */
  confirm(args: SportsbookConfirmArgs): Promise<SportsbookLedgerOutcome>;
  /** Returns the cash stake of a reserved bet. For a bet core never saw it leaves a tombstone that refuses a later reserve. */
  cancel(args: SportsbookCancelArgs): Promise<SportsbookLedgerOutcome>;
  /** Pays the total payout of an accepted bet, then offsets any sportsbook debt in its currency. Never gated by config, restriction or RG. */
  settle(args: SportsbookSettleArgs): Promise<SportsbookLedgerOutcome>;
  /** Takes back what the last settlement paid and puts the bet back to accepted at the next version; a shortfall becomes debt. */
  reopen(args: SportsbookReopenArgs): Promise<SportsbookLedgerOutcome>;
};

export const SPORTSBOOK_LEDGER: Token<SportsbookLedger> = createToken('SPORTSBOOK_LEDGER');
