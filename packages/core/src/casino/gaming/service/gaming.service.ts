import {
  type EventBus,
  createDomainError,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import { eq, and, asc, desc } from 'drizzle-orm';
import {
  type GameAdapter,
  type PlayEligibilityPort,
  type WalletCommands,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import { game, gameRound, type Game, type GameRound } from '../schema/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

export const RgRestrictedError = makeConflictError(
  'RgRestrictedError',
  'play is restricted by an active responsible-gambling exclusion',
);
export const InsufficientBalanceError = createDomainError<[available: string, requested: string]>(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

function toGame(record: typeof game.$inferSelect) {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    gameType: record.gameType,
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
    private readonly walletCommands: WalletCommands,
    private readonly identityReader: IdentityReader,
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

  async startRound(userId: User['id'], gameId: Game['id'], currency: string, betAmount: string) {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }

    await this.getGame(gameId);

    const round = await this.drizzle.db.transaction(async (tx) => {
      const outcome = await this.walletCommands.debit(tx, {
        userId,
        amount: betAmount,
        type: 'bet',
      });
      if (!outcome.ok) {
        throw new InsufficientBalanceError(outcome.available, betAmount);
      }
      return findOneOrThrow(
        await tx
          .insert(gameRound)
          .values({
            gameId,
            userId,
            currency,
            betAmount,
            status: 'active',
          })
          .returning(),
        new GameRoundNotFoundError(gameId),
      );
    });

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    this.events.emit('gaming.round.started', {
      roundId: round.id,
      gameId,
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
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

    this.events.emit('gaming.round.ended', {
      roundId,
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
    });

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
