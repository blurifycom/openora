import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import { eq, and, asc, desc } from 'drizzle-orm';
import { type GameAdapter, type PlayEligibilityPort, type User } from '@openora/core/contracts';
import { game, gameRound, type Game, type GameRound } from '../schema/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

export const RgRestrictedError = makeConflictError(
  'RgRestrictedError',
  'play is restricted by an active responsible-gambling exclusion',
);

function toGame(record: typeof game.$inferSelect) {
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

function toGameRound(record: typeof gameRound.$inferSelect) {
  return serializeRow(record, { dateFields: ['startedAt', 'endedAt'] });
}

export class GamingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly provider: GameAdapter,
    private readonly playEligibility: PlayEligibilityPort,
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

  async startRound(userId: User['id'], gameId: Game['id'], currency: string) {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }

    await this.getGame(gameId);

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    const round = findOneOrThrow(
      await this.drizzle.db
        .insert(gameRound)
        .values({
          gameId,
          userId,
          currency,
          status: 'active',
        })
        .returning(),
      new GameRoundNotFoundError(gameId),
    );

    this.events.emit('gaming.round.started', {
      roundId: round.id,
      gameId,
      userId,
      currency,
    });

    return { roundId: round.id, launchUrl, token };
  }

  async endRound(
    userId: User['id'],
    roundId: GameRound['id'],
  ): Promise<{ success: true; outcome?: unknown }> {
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

  async getUserRounds(userId: User['id']) {
    const rounds = await this.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.userId, userId))
      .orderBy(desc(gameRound.startedAt))
      .limit(50);
    return rounds.map(toGameRound);
  }
}
