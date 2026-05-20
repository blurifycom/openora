import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import type { Game, GameRound } from '../schemas/index.js';
import type { GameProvider } from './ports.js';
import { GAME_PROVIDER } from './ports.js';

export class GameNotFoundError extends Error {
  constructor(id: string) {
    super(`Game not found: ${id}`);
    this.name = 'GameNotFoundError';
  }
}

export class GameRoundNotFoundError extends Error {
  constructor(id: string) {
    super(`Game round not found: ${id}`);
    this.name = 'GameRoundNotFoundError';
  }
}

function toGame(record: {
  id: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl: string | null;
  isActive: boolean;
  metadata: unknown;
}): Game {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    thumbnailUrl: record.thumbnailUrl,
    isActive: record.isActive,
    metadata: record.metadata,
  };
}

function toGameRound(record: {
  id: string;
  gameId: string;
  userId: string;
  status: string;
  betAmount: { toString(): string };
  winAmount: { toString(): string };
  currency: string;
  startedAt: Date;
  endedAt: Date | null;
}): GameRound {
  return {
    id: record.id,
    gameId: record.gameId,
    userId: record.userId,
    status: record.status as GameRound['status'],
    betAmount: record.betAmount.toString(),
    winAmount: record.winAmount.toString(),
    currency: record.currency,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
  };
}

@Injectable()
export class GamingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(GAME_PROVIDER) private readonly provider: GameProvider,
  ) {}

  async listGames(tenantId?: string): Promise<Game[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const games = await (this.prisma as any).game.findMany({
      where: {
        isActive: true,
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { name: 'asc' },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    return (games as any[]).map(toGame);
  }

  async getGame(id: string): Promise<Game> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const game = await (this.prisma as any).game.findUnique({ where: { id } });
    if (!game) throw new GameNotFoundError(id);
    return toGame(game as Parameters<typeof toGame>[0]);
  }

  async startRound(
    userId: string,
    gameId: string,
    currency: string,
  ): Promise<{ roundId: string; launchUrl: string; token: string }> {
    await this.getGame(gameId);

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    // oxlint-disable-next-line typescript/no-explicit-any
    const round = await (this.prisma as any).gameRound.create({
      data: {
        gameId,
        userId,
        currency,
        status: 'active',
      },
    });

    this.events.emit('gaming.round.started', {
      roundId: (round as { id: string }).id,
      gameId,
      userId,
      currency,
    });

    return { roundId: (round as { id: string }).id, launchUrl, token };
  }

  async endRound(userId: string, roundId: string): Promise<{ success: true; outcome?: unknown }> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const round = await (this.prisma as any).gameRound.findUnique({ where: { id: roundId } });
    if (!round) throw new GameRoundNotFoundError(roundId);

    await this.provider.endRound(roundId);

    // oxlint-disable-next-line typescript/no-explicit-any
    await (this.prisma as any).gameRound.update({
      where: { id: roundId },
      data: {
        status: 'completed',
        endedAt: new Date(),
      },
    });

    this.events.emit('gaming.round.ended', { roundId, userId });

    return { success: true };
  }

  async getUserRounds(userId: string): Promise<GameRound[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const rounds = await (this.prisma as any).gameRound.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    return (rounds as any[]).map(toGameRound);
  }
}
