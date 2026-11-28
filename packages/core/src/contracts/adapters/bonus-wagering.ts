import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createSealedToken, type SealedToken } from './token.js';
import type { WagerContext } from './wager-context.js';
import type { WagerTrackingWalletCredit } from './wager-tracking.js';

export type BonusWagerArgs = {
  userId: string;
  currency: string;
  stake: string;
  realAvailable: string;
  context: WagerContext;
  providerName: string;
  externalRoundId: string;
};

export type BonusWagerOutcome =
  | {
      ok: true;
      grantId: string | null;
      bonusSpent: string;
      weightedAmount: string;
      bonusBalanceAfter: string;
      walletCredits: WagerTrackingWalletCredit[];
    }
  | { ok: false; reason: 'insufficient_bonus'; bonusAvailable: string }
  | { ok: false; reason: 'restricted_funds'; permitted: string }
  | { ok: false; reason: 'max_bet_exceeded'; maxBet: string; roundStake: string };

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
  amount: string;
  providerName: string;
  externalRoundId: string;
  kind: Extract<WalletTransactionType, 'win' | 'bet_reversal'>;
  realBalance: string;
  final?: boolean;
};

export type BonusCompletion = { grantId: string; convertedAmount: string };

export type BonusCloseRoundArgs = {
  userId: string;
  currency: string;
  providerName: string;
  externalRoundId: string;
  realBalance: string;
};

export type BonusSettleOutcome = {
  bonusShare: string;
  realShare: string;
  completed: BonusCompletion[];
};

export type BonusWageringCommands = {
  wager(tx: unknown, args: BonusWagerArgs): Promise<BonusWagerOutcome>;
  settle(tx: unknown, args: BonusSettleArgs): Promise<BonusSettleOutcome>;
  closeRound(tx: unknown, args: BonusCloseRoundArgs): Promise<{ completed: BonusCompletion[] }>;
};

export const BONUS_WAGERING: SealedToken<BonusWageringCommands> =
  createSealedToken('bonus-wagering-engine');
