export interface GameProvider {
  launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }>;
  endRound(externalRoundId: string): Promise<void>;
}

export const GAME_PROVIDER = Symbol('GAME_PROVIDER');
