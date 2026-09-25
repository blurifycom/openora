/**
 * Wager tracking command port: the bonus engine calls this from inside the same debit
 * transaction once it has resolved a bet's weight, so gamification can advance its streak, race
 * and rank counters without reading bonus tables or re-implementing weight resolution.
 *
 * A port rather than a domain event for the same reason as BONUS_WAGERING: the bus is
 * best-effort, and a dropped event is lost standing in a competition that pays cash. Resolve it
 * optionally - gamification may not be loaded.
 */
import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';

export type WagerTrackingArgs = {
  userId: string;
  currency: string;
  /** Stake before weighting, as a decimal string. */
  amount: string;
  /** Stake after the bonus engine's resolved weight, as a decimal string. */
  weightedAmount: string;
  /**
   * The part of `amount` staked out of the player's own funds - `amount` minus whatever a bonus
   * grant covered. Rank/streak counters intentionally ignore this and count the full stake (see
   * their own doc comments); it exists for a consumer that must not reward money the player never
   * risked, such as real-money rakeback.
   */
  realAmount: string;
  context: WagerContext;
};

/**
 * A real-money wallet credit a `recordWager` consumer made inside the caller's own transaction -
 * rank rakeback today. Reported back rather than fired as an event from inside the port, since a
 * consumer here has no view of when the caller's transaction actually commits; the caller collects
 * these and emits `wallet.balance.changed` itself once it does, the same rule every other wallet
 * mover in `WalletCommandsService` follows.
 */
export type WagerTrackingWalletCredit = {
  transactionId: string;
  amount: string;
  currency: string;
};

export type WagerTrackingCommands = {
  /** Empty array when nothing here moved real money - the common case. */
  recordWager(tx: unknown, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]>;
};

export const WAGER_TRACKING: Token<WagerTrackingCommands> = createToken('WAGER_TRACKING');
