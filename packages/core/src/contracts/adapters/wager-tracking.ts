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

/**
 * The provider round a wager belongs to, qualified the same way the bonus engine qualifies it: two
 * providers, or two currencies, can mint the same round id independently.
 */
export type WagerRound = {
  providerName: string;
  externalRoundId: string;
};

export type WagerTrackingArgs = {
  userId: string;
  currency: string;
  /** Stake before weighting, as a decimal string. */
  amount: string;
  /** Stake after the bonus engine's resolved weight, as a decimal string. */
  weightedAmount: string;
  /**
   * The part of `amount` staked out of the player's own funds - `amount` minus whatever a bonus
   * grant covered. `RankService`'s lifetime-wagering counter intentionally ignores this and
   * counts the full stake (see its own doc comment); every other consumer here - rakeback,
   * streak, races, the rank challenge - counts only this, since none of them may reward money
   * the player never risked.
   */
  realAmount: string;
  context: WagerContext;
  /**
   * What a later rollback of this round is matched against. Absent, the wager still counts but
   * can never be taken back - the wallet only ever settles a round it was given an id for.
   */
  round?: WagerRound;
};

/**
 * A provider rollback of (part of) a round's stake. `realAmount` is the part of the reversed
 * amount that was the player's own money - the same basis `recordWager` counted on - and a
 * consumer takes back at most what that round still has standing with it, so a rollback larger
 * than the stake, or a second one for the same round, never takes more than was counted.
 */
export type WagerReversalArgs = {
  userId: string;
  currency: string;
  round: WagerRound;
  realAmount: string;
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
  /**
   * Takes a rolled-back stake back out of whatever counter it advanced. Optional: a consumer whose
   * counter is deliberately monotonic (the rank ladder) has nothing to undo.
   */
  reverseWager?(tx: unknown, args: WagerReversalArgs): Promise<void>;
};

export const WAGER_TRACKING: Token<WagerTrackingCommands> = createToken('WAGER_TRACKING');
