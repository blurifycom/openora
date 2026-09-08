/**
 * Gaming command port: a wallet bridge accumulates a provider-reported round delta on the
 * caller's own `tx`, atomic with whatever wallet move the caller makes in the same
 * transaction. Mirrors the WALLET_COMMANDS command-port idiom (ADR-0017).
 */
import { createToken, type Token } from './token.js';

export type GamingAccumulateExternalRoundArgs = {
  gameId: string;
  userId: string;
  currency: string;
  externalRoundId: string;
  betDelta?: string;
  winDelta?: string;
  isFinal?: boolean;
};

export type GamingAccumulateExternalRoundOutcome = {
  roundId: string;
  betAmount: string;
  winAmount: string;
};

export type GamingCommands = {
  accumulateExternalRound(
    tx: unknown,
    args: GamingAccumulateExternalRoundArgs,
  ): Promise<GamingAccumulateExternalRoundOutcome>;
};

export const GAMING_COMMANDS: Token<GamingCommands> = createToken('GAMING_COMMANDS');
