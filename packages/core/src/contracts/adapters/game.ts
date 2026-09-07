/**
 * Gaming integration seam. A game studio/RGS implements GameAdapter; bind a
 * concrete adapter to GAME_ADAPTER in the module's plugin.ts.
 */
import { createToken, type Token } from './token.js';

/**
 * What the provider reports when a round closes. `winAmount` is a decimal string in the
 * round's own currency and is the only number the win credit may use - never a client's.
 * A void return, or an omitted `winAmount`, is a round that paid nothing.
 */
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
