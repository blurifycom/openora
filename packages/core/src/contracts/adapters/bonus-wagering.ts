/**
 * Bonus wagering command port: wallet calls this from inside its debit and credit transactions,
 * so a bet and the wagering progress it produced can never disagree.
 *
 * Both calls sit below the wallet's duplicate-provider-reference guard, so a replayed wager
 * cannot reach them.
 *
 * Sealed: weight resolution, grant attribution and the completion threshold are regulated
 * arithmetic an operator may configure but never replace.
 */
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createSealedToken, type SealedToken } from './token.js';
import type { WagerContext } from './wager-context.js';
import type { WagerTrackingWalletCredit } from './wager-tracking.js';

export type BonusWagerArgs = {
  userId: string;
  /** Currency the bet was placed in. Only a grant held in this currency can fund or score it. */
  currency: string;
  /** Full stake, as a decimal string, before any weighting and regardless of which balance pays. */
  stake: string;
  /**
   * Real balance the stake may draw on, as a decimal string. The engine splits the stake across
   * free real money and the grant's buckets; the wallet debits `stake - bonusSpent` from it.
   */
  realAvailable: string;
  context: WagerContext;
  /**
   * The wallet's own provider identity for this bet (`providerRef.providerName`), not
   * `context.provider` - a weight-resolution concept that need not match it. `settle` looks a
   * round up by this same identity, so persisting the wrong one would let it find nothing, or
   * the wrong provider's round.
   */
  providerName: string;
  /**
   * Provider round this bet belongs to. `settle` finds the funding grant by it, so a bet without
   * one could spend bonus funds whose win or reversal then lands entirely on the real balance.
   */
  externalRoundId: string;
};

export type BonusWagerOutcome =
  | {
      ok: true;
      /**
       * First grant the bet was attributed to, in rollover order, or `null` when none was: the
       * player holds none, or the product never uses bonus funds.
       */
      grantId: string | null;
      /** Part of the stake taken from bonus funds (bucket C). The rest is real money. */
      bonusSpent: string;
      /**
       * Stake after weighting, each part at the weight of the grant it was attributed to, as a
       * decimal string. `'0'` when the bet does not count.
       * Uncapped: a bet that finishes a requirement reports the whole weighted stake, not the part
       * the grant had room for, because a wager counter measures turnover rather than absorption.
       */
      weightedAmount: string;
      /** Bonus funds left across the player's active grants in the bet's currency. */
      bonusBalanceAfter: string;
      /** Whatever a `WAGER_TRACKING` consumer credited to the real balance alongside this bet - rank rakeback today. */
      walletCredits: WagerTrackingWalletCredit[];
    }
  /** Real and bonus funds together could not cover the stake. The wallet turns this into its own insufficient-funds outcome. */
  | { ok: false; reason: 'insufficient_bonus'; bonusAvailable: string }
  /**
   * The round's total stake, this bet included, is larger than the strictest `maxBet` among the
   * active grants. A refusal, not a silent pass: the limit exists so a player cannot turn a
   * wagering requirement into one high-variance spin, and a bet that quietly ignored it would do
   * exactly that.
   */
  | { ok: false; reason: 'max_bet_exceeded'; maxBet: string; roundStake: string };

/**
 * A stake refused because the round's total is over the active grant's `maxBet`. `roundStake`
 * equals `stake` for a round's first debit. Shared here rather than
 * module-local, the same as `RgLimitExceededError` beside `RG_LIMITS`: the wallet throws it from
 * inside `debit`, but whatever router sits above the caller (a game round) is
 * the one that has to map it to a response, and it can only do that against a class it can import.
 */
export class MaxBetExceededError extends Error {
  readonly stake: string;
  readonly maxBet: string;
  readonly roundStake: string;

  constructor(stake: string, maxBet: string, roundStake: string = stake) {
    super(
      `stake ${roundStake} is over the ${maxBet} maximum bet the active bonus was granted under`,
    );
    this.name = 'MaxBetExceededError';
    this.stake = stake;
    this.maxBet = maxBet;
    this.roundStake = roundStake;
  }
}

export type BonusSettleArgs = {
  userId: string;
  currency: string;
  /** Full amount the provider reported, before the real/bonus split. */
  amount: string;
  /**
   * Qualifies `externalRoundId`: two providers can mint the same round id independently, and
   * without this a win from one could find and settle against a stake taken by the other.
   */
  providerName: string;
  externalRoundId: string;
  kind: Extract<WalletTransactionType, 'win' | 'bet_reversal'>;
  /** Real balance before this credit; the grant's real-cash counters never exceed it. */
  realBalance: string;
  /**
   * The provider marked this the round's last result. Without it a win leaves the round open, and
   * a reversal closes it only once nothing is left staked on it, so no grant completes mid-round.
   */
  final?: boolean;
};

/**
 * A grant whose wagering requirement is met and whose last open bet has settled, and the bonus
 * funds it owes the real balance. The wallet performs the credit itself, so the two modules never
 * call back into each other.
 */
export type BonusCompletion = { grantId: string; convertedAmount: string };

/** A round that settled with nothing to pay back: a lost bet. */
export type BonusCloseRoundArgs = {
  userId: string;
  currency: string;
  providerName: string;
  externalRoundId: string;
  realBalance: string;
};

export type BonusSettleOutcome = {
  /**
   * Part of `amount` that belongs to the bonus balance, already applied there. `'0'` when the
   * round drew no bonus funds.
   */
  bonusShare: string;
  /**
   * Part of `amount` the wallet credits to the real balance. Not simply `amount - bonusShare`: a
   * reversal is bounded by what the round still has outstanding, so a duplicate rollback callback
   * reports `'0'` on both shares rather than paying an already-returned stake out as cash.
   */
  realShare: string;
  /** Grants this settlement let complete: requirement met and no bet of theirs still open. */
  completed: BonusCompletion[];
};

export type BonusWageringCommands = {
  wager(tx: unknown, args: BonusWagerArgs): Promise<BonusWagerOutcome>;
  settle(tx: unknown, args: BonusSettleArgs): Promise<BonusSettleOutcome>;
  closeRound(tx: unknown, args: BonusCloseRoundArgs): Promise<{ completed: BonusCompletion[] }>;
};

export const BONUS_WAGERING: SealedToken<BonusWageringCommands> =
  createSealedToken('bonus-wagering-engine');
