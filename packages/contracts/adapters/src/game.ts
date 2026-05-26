// Gaming integration seam. A game studio/RGS implements GameAdapter; bind a
// concrete adapter to GAME_ADAPTER in the module's plugin.ts.

export interface GameAdapter {
  launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }>;
  endRound(externalRoundId: string): Promise<void>;
}

export const GAME_ADAPTER = Symbol('GAME_ADAPTER');
