import {
  type EventBus,
  createDomainError,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import { eq, and, asc, desc, inArray } from 'drizzle-orm';
import {
  RgLimitExceededError,
  type GameAdapter,
  type PlayEligibilityPort,
  type RgLimitsPort,
  type WalletCommands,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
  type Game,
  type GameRound,
} from '../schema/index.js';

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

function toGame(row: {
  game: typeof game.$inferSelect;
  provider: typeof gameProvider.$inferSelect;
  categories: (typeof gameCategory.$inferSelect)[];
}) {
  return {
    id: row.game.id,
    name: row.game.name,
    slug: row.game.slug,
    provider: {
      id: row.provider.id,
      slug: row.provider.slug,
      name: row.provider.name,
      logoUrl: row.provider.logoUrl,
    },
    aggregator: row.game.aggregator,
    categories: row.categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      sortOrder: c.sortOrder,
    })),
    gameType: row.game.gameType,
    thumbnailUrl: row.game.thumbnailUrl,
    isActive: row.game.isActive,
    metadata: row.game.metadata,
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
    private readonly rgLimits?: RgLimitsPort,
  ) {}

  async listGames() {
    const rows = await this.drizzle.db
      .select({ game, provider: gameProvider })
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .where(eq(game.isActive, true))
      .orderBy(asc(game.name));
    const categories = await this.categoriesByGameIds(rows.map((r) => r.game.id));
    return rows.map((r) => toGame({ ...r, categories: categories.get(r.game.id) ?? [] }));
  }

  async getGame(id: string) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .select({ game, provider: gameProvider })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    const categories = await this.categoriesByGameIds([row.game.id]);
    return toGame({ ...row, categories: categories.get(row.game.id) ?? [] });
  }

  private async categoriesByGameIds(gameIds: Game['id'][]) {
    if (gameIds.length === 0) {
      return new Map<Game['id'], (typeof gameCategory.$inferSelect)[]>();
    }
    const rows = await this.drizzle.db
      .select({ gameId: gameCategoryGame.gameId, category: gameCategory })
      .from(gameCategoryGame)
      .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
      .where(inArray(gameCategoryGame.gameId, gameIds))
      .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name));
    const map = new Map<Game['id'], (typeof gameCategory.$inferSelect)[]>();
    for (const r of rows) {
      const list = map.get(r.gameId);
      if (list) {
        list.push(r.category);
      } else {
        map.set(r.gameId, [r.category]);
      }
    }
    return map;
  }

  async startRound(userId: User['id'], gameId: Game['id'], currency: string, betAmount: string) {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }
    const decision = await this.rgLimits?.checkWager(this.drizzle.db, userId, betAmount, currency);
    if (decision && !decision.allowed) {
      throw new RgLimitExceededError('wager_limit_exceeded', decision);
    }

    await this.getGame(gameId);

    const { round, completedBonusCredits } = await this.drizzle.db.transaction(async (tx) => {
      // The same currency the RG pre-check above weighed. Left off, the debit falls on the
      // player's active currency, and the two would then judge different moves.
      const outcome = await this.walletCommands.debit(tx, {
        userId,
        amount: betAmount,
        currency,
        type: 'bet',
      });
      if (!outcome.ok) {
        throw new InsufficientBalanceError(outcome.available, betAmount);
      }
      const insertedRound = findOneOrThrow(
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
      return { round: insertedRound, completedBonusCredits: outcome.completedBonusCredits ?? [] };
    });

    for (const credit of completedBonusCredits) {
      this.events.emit('wallet.bonus_rollover.completed', {
        userId,
        creditId: credit.id,
        currency: credit.currency,
        creditedAmount: credit.creditedAmount,
      });
    }

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
