import { Injectable } from '@nestjs/common';
import type { GameProvider } from '../../service/ports.js';

@Injectable()
export class MockGameProvider implements GameProvider {
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
