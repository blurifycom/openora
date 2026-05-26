import { Injectable } from '@nestjs/common';
import type { GameAdapter } from '@oss/module-gaming';

/**
 * Consumer's real game provider implementation.
 *
 * Replaces the OSS MockGameAdapter at DI resolution time via:
 *   ctx.providers.add({ provide: GAME_ADAPTER, useClass: ConsumerGameAdapter })
 *
 * A real implementation would call an internal game engine or a licensed
 * aggregator's SDK here - never a raw fetch/axios call (use a port adapter
 * injected via the constructor instead).
 */
@Injectable()
export class ConsumerGameAdapter implements GameAdapter {
  async launchGame(
    gameId: string,
    userId: string,
    currency: string,
  ): Promise<{ launchUrl: string; token: string }> {
    // In production: call the internal Consumer game engine via an injected port.
    const token = `bf-${Date.now()}-${userId}`;
    const launchUrl =
      `https://games.consumer.example.com/play/${gameId}` +
      `?user=${userId}&currency=${currency}&token=${token}`;
    return { launchUrl, token };
  }

  async endRound(_externalRoundId: string): Promise<void> {
    // In production: notify the game engine that the round has closed.
  }
}
