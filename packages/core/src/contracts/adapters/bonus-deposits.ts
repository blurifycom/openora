import { createToken, type Token } from './token.js';

export type BonusDepositArgs = {
  userId: string;
  amount: string;
  currency: string;
  transactionId: string;
};

export type BonusDepositCommands = {
  applyDeposit(tx: unknown, args: BonusDepositArgs): Promise<void>;
};

export const BONUS_DEPOSITS: Token<BonusDepositCommands> = createToken('BONUS_DEPOSITS');
