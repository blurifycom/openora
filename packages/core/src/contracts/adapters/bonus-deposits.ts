/**
 * Deposit bonus command port: the wallet calls it inside the transaction that credits a completed
 * deposit, so a deposit and the bonus it earned commit together or not at all. The wallet's own
 * guard against crediting a deposit twice is what makes a replay grant nothing twice.
 */
import { createToken, type Token } from './token.js';

export type BonusDepositArgs = {
  userId: string;
  amount: string;
  currency: string;
  /** The completed deposit's wallet transaction. */
  transactionId: string;
};

export type BonusDepositCommands = {
  applyDeposit(tx: unknown, args: BonusDepositArgs): Promise<void>;
};

export const BONUS_DEPOSITS: Token<BonusDepositCommands> = createToken('BONUS_DEPOSITS');
