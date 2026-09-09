import {
  type EventBus,
  type DrizzleDb,
  createDomainError,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  likeContains,
  pageToOffset,
  serializeRow,
  uniqueConstraintName,
} from '@openora/core/server';
import { eq, and, asc, count, desc, exists, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import {
  RgLimitExceededError,
  type ClientMeta,
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
  type GameCategory,
  type GameProvider,
  type GameRound,
} from '../schema/index.js';
import { GameProviderNotFoundError } from './game-provider.service.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import {
  categoriesByGameIds,
  isGamePlayable,
  playableGameCondition,
} from '../../shared/game-catalog.js';
import type { UpdateGameInput } from '../contract/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

export const GameSlugTakenError = makeConflictError(
  'GameSlugTakenError',
  'A game with this slug already exists',
);

type Actor = {
  actorId?: User['id'];
} & ClientMeta;

export const RgRestrictedError = makeConflictError(
  'RgRestrictedError',
  'play is restricted by an active responsible-gambling exclusion',
);
export const InsufficientBalanceError = createDomainError<[available: string, requested: string]>(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);
// Thrown inside the settlement transaction, so the round stays `active` and the win can be
// settled again rather than being lost silently.
export const WinCreditFailedError = createDomainError<[roundId: string, reason: string]>(
  'WinCreditFailedError',
  (roundId, reason) => `win credit failed for round ${roundId}: ${reason}`,
);

export const ExternalRoundOwnerMismatchError = createDomainError<[externalRoundId: string]>(
  'ExternalRoundOwnerMismatchError',
  (externalRoundId) =>
    `externalRoundId ${externalRoundId} is already tagged to a different game/user`,
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

  async listGames({
    page,
    limit,
    q,
    providerId,
    categoryId,
    isActive,
  }: {
    page: number;
    limit: number;
    q?: string;
    providerId?: GameProvider['id'];
    categoryId?: GameCategory['id'];
    isActive?: boolean;
  }) {
    const where = and(
      q ? or(ilike(game.name, likeContains(q)), ilike(game.slug, likeContains(q))) : undefined,
      providerId ? eq(game.providerId, providerId) : undefined,
      isActive === true
        ? playableGameCondition()
        : isActive === undefined
          ? undefined
          : eq(game.isActive, isActive),
      categoryId
        ? exists(
            this.drizzle.db
              .select({ gameId: gameCategoryGame.gameId })
              .from(gameCategoryGame)
              .where(
                and(
                  eq(gameCategoryGame.gameId, game.id),
                  eq(gameCategoryGame.categoryId, categoryId),
                ),
              ),
          )
        : undefined,
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({ game, provider: gameProvider })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(where)
        .orderBy(asc(game.name))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db
        .select({ n: count() })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(where),
    ]);
    const categories = await categoriesByGameIds(
      this.drizzle.db,
      rows.map((r) => r.game.id),
    );
    return {
      items: rows.map((r) => toGame({ ...r, categories: categories.get(r.game.id) ?? [] })),
      total: Number(n),
      page,
      limit,
    };
  }

  async getGame(id: string, opts: { activeOnly?: boolean } = {}) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .select({ game, provider: gameProvider })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    // The public detail route passes activeOnly: internal callers (updateGame's
    // return value) keep the unfiltered row so an admin still sees what they wrote.
    if (opts.activeOnly && !isGamePlayable(row.game, row.provider)) {
      throw new GameNotFoundError(id);
    }
    const categories = await categoriesByGameIds(this.drizzle.db, [row.game.id]);
    return toGame({ ...row, categories: categories.get(row.game.id) ?? [] });
  }

  async startRound(userId: User['id'], gameId: Game['id'], currency: string, betAmount: string) {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }
    const decision = await this.rgLimits?.checkWager(this.drizzle.db, userId, betAmount, currency);
    if (decision && !decision.allowed) {
      throw new RgLimitExceededError('wager_limit_exceeded', decision);
    }

    await this.getGame(gameId, { activeOnly: true });

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
  ): Promise<{ success: true; winAmount: string }> {
    // Without RLS (ADR-0026, single-tenant) this userId filter is the sole access guard.
    const round = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameRound)
        .where(and(eq(gameRound.id, roundId), eq(gameRound.userId, userId))),
      new GameRoundNotFoundError(roundId),
    );

    // A round that already closed reports what it paid and stops here - re-calling the
    // provider would ask a settled round for its outcome a second time.
    if (round.status !== 'active') {
      return { success: true, winAmount: round.winAmount };
    }

    const outcome = await this.provider.endRound(roundId);
    // The provider's number, never the caller's: the win is credited off this alone.
    const winAmount = outcome?.winAmount ?? '0';

    const paid = await this.drizzle.db.transaction(async (tx) => {
      // `status = 'active'` is the payout guard: two concurrent end-round calls both
      // reach here, only one updates a row, so the win is credited exactly once.
      const settled = await tx
        .update(gameRound)
        .set({ status: 'completed', endedAt: new Date(), winAmount })
        .where(
          and(
            eq(gameRound.id, roundId),
            eq(gameRound.userId, userId),
            eq(gameRound.status, 'active'),
          ),
        )
        .returning({ id: gameRound.id });
      if (settled.length === 0) {
        return false;
      }
      if (Number(winAmount) > 0) {
        // The bet already opened this currency's balance, so `allowNewCurrency` only
        // covers a player whose active currency moved between start and settlement.
        const credited = await this.walletCommands.credit(tx, {
          userId,
          amount: winAmount,
          currency: round.currency,
          type: 'win',
          allowNewCurrency: true,
        });
        if (!credited.ok) {
          throw new WinCreditFailedError(roundId, credited.reason);
        }
      }
      return true;
    });

    this.events.emit('gaming.round.ended', {
      roundId,
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
    });

    return { success: true, winAmount: paid ? winAmount : round.winAmount };
  }

  /**
   * `targetWhere` must repeat the partial index's predicate (schema/index.ts) - Postgres
   * rejects ON CONFLICT against a partial index without it. Deltas add onto the stored
   * value, not `excluded.<col>`, so concurrent callbacks each apply their own delta.
   */
  async accumulateExternalRound(
    tx: unknown,
    args: {
      gameId: Game['id'];
      userId: User['id'];
      currency: string;
      externalRoundId: NonNullable<GameRound['externalRoundId']>;
      betDelta?: string;
      winDelta?: string;
      isFinal?: boolean;
    },
  ): Promise<{ roundId: GameRound['id']; betAmount: string; winAmount: string }> {
    const txn = tx as DrizzleDb;
    const betDelta = args.betDelta ?? '0';
    const winDelta = args.winDelta ?? '0';
    const status = args.isFinal ? 'completed' : 'active';
    const endedAt = args.isFinal ? new Date() : undefined;
    const [row] = await txn
      .insert(gameRound)
      .values({
        gameId: args.gameId,
        userId: args.userId,
        currency: args.currency,
        externalRoundId: args.externalRoundId,
        betAmount: betDelta,
        winAmount: winDelta,
        status,
        endedAt,
      })
      .onConflictDoUpdate({
        target: gameRound.externalRoundId,
        targetWhere: sql`${gameRound.externalRoundId} IS NOT NULL`,
        set: {
          betAmount: sql`${gameRound.betAmount} + ${betDelta}::numeric`,
          winAmount: sql`${gameRound.winAmount} + ${winDelta}::numeric`,
          ...(args.isFinal ? { status, endedAt } : {}),
        },
        // A conflicting row owned by a different game/user is left untouched (0 rows
        // returned) instead of merging deltas onto someone else's round.
        setWhere: and(eq(gameRound.userId, args.userId), eq(gameRound.gameId, args.gameId)),
      })
      .returning({
        id: gameRound.id,
        betAmount: gameRound.betAmount,
        winAmount: gameRound.winAmount,
      });
    if (!row) {
      throw new ExternalRoundOwnerMismatchError(args.externalRoundId);
    }
    return { roundId: row.id, betAmount: row.betAmount, winAmount: row.winAmount };
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

  async updateGame({
    id,
    categoryIds,
    actorId,
    ip,
    userAgent,
    ...patchInput
  }: UpdateGameInput & Actor) {
    const uniqueCategoryIds = categoryIds === undefined ? undefined : [...new Set(categoryIds)];
    const patch: Partial<typeof game.$inferInsert> = { ...patchInput };
    const hasScalarChanges = Object.values(patch).some((value) => value !== undefined);
    if (!hasScalarChanges && uniqueCategoryIds === undefined) {
      return this.getGame(id);
    }
    const [beforeRow] = await this.drizzle.db.select().from(game).where(eq(game.id, id)).limit(1);
    if (!beforeRow) {
      throw new GameNotFoundError(id);
    }
    const beforeLinks = await this.drizzle.db
      .select({ categoryId: gameCategoryGame.categoryId })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.gameId, id));
    const beforeCategoryIds = beforeLinks.map((r) => r.categoryId);
    if (patchInput.providerId !== undefined) {
      findOneOrThrow(
        await this.drizzle.db
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.id, patchInput.providerId))
          .limit(1),
        new GameProviderNotFoundError(patchInput.providerId),
      );
    }
    if (patchInput.slug !== undefined) {
      const [clash] = await this.drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(and(eq(game.slug, patchInput.slug), ne(game.id, id)))
        .limit(1);
      if (clash) {
        throw new GameSlugTakenError();
      }
    }
    if (uniqueCategoryIds !== undefined) {
      const rows =
        uniqueCategoryIds.length > 0
          ? await this.drizzle.db
              .select()
              .from(gameCategory)
              .where(inArray(gameCategory.id, uniqueCategoryIds))
          : [];
      const found = new Set(rows.map((r) => r.id));
      const missing = uniqueCategoryIds.find((categoryId) => !found.has(categoryId));
      if (missing) {
        throw new GameCategoryNotFoundError(missing);
      }
    }
    try {
      await this.drizzle.db.transaction(async (tx) => {
        findOneOrThrow(
          await tx.select({ id: game.id }).from(game).where(eq(game.id, id)).limit(1),
          new GameNotFoundError(id),
        );
        if (hasScalarChanges) {
          await tx.update(game).set(patch).where(eq(game.id, id));
        }
        if (uniqueCategoryIds !== undefined) {
          await tx.delete(gameCategoryGame).where(eq(gameCategoryGame.gameId, id));
          if (uniqueCategoryIds.length > 0) {
            await tx
              .insert(gameCategoryGame)
              .values(uniqueCategoryIds.map((categoryId) => ({ gameId: id, categoryId })));
          }
        }
      });
    } catch (error) {
      // The transaction also writes category links: only a slug collision maps
      // to GameSlugTakenError, a link race must not masquerade as one.
      if (uniqueConstraintName(error) === 'game_slug_key') {
        throw new GameSlugTakenError();
      }
      throw error;
    }
    const [afterRow] = await this.drizzle.db.select().from(game).where(eq(game.id, id)).limit(1);
    if (!afterRow) {
      throw new GameNotFoundError(id);
    }
    const afterCategoryIds = uniqueCategoryIds ?? beforeCategoryIds;
    this.events.emit('gaming.game.updated', {
      gameId: id,
      actorId,
      before: {
        slug: beforeRow.slug,
        name: beforeRow.name,
        providerId: beforeRow.providerId,
        aggregator: beforeRow.aggregator,
        thumbnailUrl: beforeRow.thumbnailUrl,
        isActive: beforeRow.isActive,
        categoryIds: beforeCategoryIds,
        metadata: beforeRow.metadata ?? null,
      },
      after: {
        slug: afterRow.slug,
        name: afterRow.name,
        providerId: afterRow.providerId,
        aggregator: afterRow.aggregator,
        thumbnailUrl: afterRow.thumbnailUrl,
        isActive: afterRow.isActive,
        categoryIds: afterCategoryIds,
        metadata: afterRow.metadata ?? null,
      },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return this.getGame(id);
  }
}
