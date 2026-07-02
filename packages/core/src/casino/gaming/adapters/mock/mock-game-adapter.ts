import type { GameAdapter } from '@blurifycom/core/contracts';

export class MockGameAdapter implements GameAdapter {
  async launchGame(gameId: string, userId: string, currency: string) {
    const token = `mock-token-${gameId}-${userId}-${Date.now()}`;
    const launchUrl = `https://mock-provider.example.com/play?gameId=${gameId}&currency=${currency}&token=${token}`;
    return { launchUrl, token };
  }

  async endRound(_externalRoundId: string) {
    // no-op for mock provider
  }
}
