// Tag-evaluation command port: wallet's withdraw() calls this synchronously, on its own
// transaction handle, so a withdrawal_review assignment is guaranteed to commit before
// maybeAutoApprove reads risk tags - closing the race an unawaited EventBus emit alone
// leaves open (`wallet.withdrawal.requested` is still fired for other consumers, but
// auto-approval's money decision must never depend on that fire-and-forget fan-out; see
// messaging-and-microservices "money never flows over events"). Mirrors the WALLET_COMMANDS
// command-port idiom (ADR-0017): `tx: unknown` so the caller's transaction handle threads
// through without either side importing the other's DB module.
import { createToken, type Token } from './token.js';

export type TagEvaluationWithdrawalRequestedArgs = {
  userId: string;
  amount: string;
};

export type TagEvaluationCommands = {
  evaluateWithdrawalRequested(
    tx: unknown,
    args: TagEvaluationWithdrawalRequestedArgs,
  ): Promise<void>;
};

export const TAG_EVALUATION_COMMANDS: Token<TagEvaluationCommands> =
  createToken('TAG_EVALUATION_COMMANDS');
