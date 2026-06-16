// Gaming integration seam. A game studio/RGS implements GameAdapter; bind a
// concrete adapter to GAME_ADAPTER in the module's plugin.ts.
import { createToken, type Token } from './token.js';

export type GameAdapter = {
  launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }>;
  endRound(externalRoundId: string): Promise<void>;
};

export const GAME_ADAPTER: Token<GameAdapter> = createToken('GAME_ADAPTER');
