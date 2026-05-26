import { Injectable } from '@nestjs/common';
import type { GameAdapter } from '@oss/adapters';

@Injectable()
export class MockGameAdapter implements GameAdapter {
  async launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }> {
    const token = `mock-token-${gameId}-${userId}-${Date.now()}`;
    const launchUrl = `https://mock-provider.example.com/play?gameId=${gameId}&currency=${currency}&token=${token}`;
    return { launchUrl, token };
  }

  async endRound(_externalRoundId: string): Promise<void> {
    // no-op for mock provider
  }
}
