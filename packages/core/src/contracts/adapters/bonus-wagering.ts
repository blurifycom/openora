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

export type BonusWagerArgs = {
  userId: string;
  /** Currency the bet was placed in. Only a grant held in this currency can fund or score it. */
  currency: string;
  /** Full stake, as a decimal string, before any weighting and regardless of which balance pays. */
  stake: string;
  /** Part of the stake the real balance could not cover. `'0'` when the player paid it all in cash. */
  fromBonus: string;
  context: WagerContext;
  /** Provider round this bet belongs to. `settle` finds the funding grant by it. */
  externalRoundId?: string;
};

export type BonusWagerOutcome =
  | {
      ok: true;
      /** Grant the bet was attributed to, or `null` when the player holds none. */
      grantId: string | null;
      /** Part of the stake actually taken from bonus funds. Echoes `fromBonus` on success. */
      bonusSpent: string;
      /**
       * Stake after the resolved weight, as a decimal string. `'0'` when the bet does not count.
       * Uncapped: a bet that finishes a requirement reports the whole weighted stake, not the part
       * the grant had room for, because a wager counter measures turnover rather than absorption.
       */
      weightedAmount: string;
      /** Bonus funds left on the attributed grant once the bet settled. */
      bonusBalanceAfter: string;
      /**
       * The grant this bet pushed over its wagering requirement, and the bonus funds it owes the
       * real balance. Singular because one bet feeds exactly one grant; a list beside a single
       * amount would invite a caller to report that amount for every grant in it. The wallet
       * performs the credit itself, so the two modules never call back into each other.
       */
      completed: { grantId: string; convertedAmount: string } | null;
    }
  /** Bonus funds could not cover `fromBonus`. The wallet turns this into its own insufficient-funds outcome. */
  | { ok: false; bonusAvailable: string };

export type BonusSettleArgs = {
  userId: string;
  currency: string;
  /** Full amount the provider reported, before the real/bonus split. */
  amount: string;
  externalRoundId: string;
  kind: Extract<WalletTransactionType, 'win' | 'bet_reversal'>;
};

export type BonusSettleOutcome = {
  /**
   * Part of `amount` that belongs to the bonus balance, already applied there. The wallet credits
   * the remainder to the real balance. `'0'` when the round drew no bonus funds.
   */
  bonusShare: string;
};

export type BonusWageringCommands = {
  wager(tx: unknown, args: BonusWagerArgs): Promise<BonusWagerOutcome>;
  settle(tx: unknown, args: BonusSettleArgs): Promise<BonusSettleOutcome>;
};

export const BONUS_WAGERING: SealedToken<BonusWageringCommands> =
  createSealedToken('bonus-wagering-engine');
