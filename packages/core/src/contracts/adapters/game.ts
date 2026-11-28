import { createToken, type Token } from './token.js';

export type RoundOutcome = { winAmount?: string };

export type GameAdapter = {
  launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }>;
  endRound(externalRoundId: string): Promise<RoundOutcome | void>;
};

export const GAME_ADAPTER: Token<GameAdapter> = createToken('GAME_ADAPTER');
