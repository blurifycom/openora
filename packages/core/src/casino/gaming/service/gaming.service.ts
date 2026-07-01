import {
  type EventBus,
  makeNotFoundError,
  DrizzleService,
  findOneOrThrow,
} from '@blurifycom/core/server';
import { eq, and, asc, desc } from 'drizzle-orm';
import { type GameAdapter } from '@blurifycom/core/contracts';
import { game, gameRound } from '../schema/index.js';
import type { Game, GameRound } from '../schemas/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

function toGame(record: typeof game.$inferSelect): Game {
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

function toGameRound(record: typeof gameRound.$inferSelect): GameRound {
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

export class GamingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly provider: GameAdapter,
  ) {}

  async listGames() {
    const games = await this.drizzle.db
      .select()
      .from(game)
      .where(eq(game.isActive, true))
      .orderBy(asc(game.name));
    return games.map(toGame);
  }

  async getGame(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(game).where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    return toGame(record);
  }

  async startRound(userId: string, gameId: string, currency: string) {
    await this.getGame(gameId);

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    const [round] = await this.drizzle.db
      .insert(gameRound)
      .values({
        gameId,
        userId,
        currency,
        status: 'active',
      })
      .returning();

    this.events.emit('gaming.round.started', {
      roundId: round!.id,
      gameId,
      userId,
      currency,
    });

    return { roundId: round!.id, launchUrl, token };
  }

  async endRound(userId: string, roundId: string): Promise<{ success: true; outcome?: unknown }> {
    // Without RLS (ADR-0026, single-tenant) this userId filter is the sole access guard.
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameRound)
        .where(and(eq(gameRound.id, roundId), eq(gameRound.userId, userId))),
      new GameRoundNotFoundError(roundId),
    );

    await this.provider.endRound(roundId);

    await this.drizzle.db
      .update(gameRound)
      .set({ status: 'completed', endedAt: new Date() })
      .where(and(eq(gameRound.id, roundId), eq(gameRound.userId, userId)));

    this.events.emit('gaming.round.ended', { roundId, userId });

    return { success: true };
  }

  async getUserRounds(userId: string) {
    const rounds = await this.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.userId, userId))
      .orderBy(desc(gameRound.startedAt))
      .limit(50);
    return rounds.map(toGameRound);
  }
}
