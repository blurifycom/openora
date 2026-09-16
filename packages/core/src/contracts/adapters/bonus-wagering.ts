/**
 * Bonus wagering command port: wallet calls this from inside its debit transaction, so a bet and
 * the wagering progress it produced can never disagree. A domain event would not do - the bus
 * emits post-commit and best-effort, and lost progress is a player's money.
 *
 * The implementation is sealed (BONUS_WAGERING_ENGINE). Weight resolution, FIFO consumption and
 * the completion threshold are regulated arithmetic an operator may not rebind.
 */
import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';

export type BonusContributeArgs = {
  userId: string;
  currency: string;
  /** Stake of the bet, as a decimal string, before any weighting. */
  amount: string;
  context: WagerContext;
};

export type BonusContributeOutcome = {
  /** Stake after the resolved weight, as a decimal string. `'0'` when the bet does not count. */
  weightedAmount: string;
  /** Grants this bet pushed over their wagering requirement. */
  completedGrantIds: string[];
};

export type BonusWageringCommands = {
  contribute(tx: unknown, args: BonusContributeArgs): Promise<BonusContributeOutcome>;
};

export const BONUS_WAGERING: Token<BonusWageringCommands> = createToken('BONUS_WAGERING');
