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
  context: WagerContext;
};

export type WagerTrackingCommands = {
  recordWager(tx: unknown, args: WagerTrackingArgs): Promise<void>;
};

export const WAGER_TRACKING: Token<WagerTrackingCommands> = createToken('WAGER_TRACKING');
