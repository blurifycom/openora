import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';

export type WagerRound = {
  providerName: string;
  externalRoundId: string;
};

export type WagerTrackingArgs = {
  userId: string;
  currency: string;
  amount: string;
  weightedAmount: string;
  realAmount: string;
  context: WagerContext;
  round?: WagerRound;
};

export type WagerReversalArgs = {
  userId: string;
  currency: string;
  round: WagerRound;
  realAmount: string;
};

export type SettledWagerArgs = {
  userId: string;
  currency: string;
  realAmount: string;
  context: WagerContext;
  round: WagerRound;
  qualifiedAt: Date;
};

export type WagerTrackingWalletCredit = {
  transactionId: string;
  amount: string;
  currency: string;
};

export type WagerTrackingCommands = {
  recordWager(tx: unknown, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]>;
  reverseWager?(tx: unknown, args: WagerReversalArgs): Promise<void>;
  recordSettledWager?(tx: unknown, args: SettledWagerArgs): Promise<WagerTrackingWalletCredit[]>;
  reverseSettledWager?(tx: unknown, args: WagerReversalArgs): Promise<void>;
  reopenSettledWager?(tx: unknown, args: WagerReversalArgs): Promise<void>;
};

export const WAGER_TRACKING: Token<WagerTrackingCommands> = createToken('WAGER_TRACKING');
