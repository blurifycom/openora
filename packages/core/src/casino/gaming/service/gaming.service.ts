import {
  type EventBus,
  type DrizzleDb,
  type DrizzleTx,
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
import {
  type SQL,
  type SQLWrapper,
  eq,
  and,
  asc,
  count,
  desc,
  exists,
  ilike,
  inArray,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { type PgColumn, type PgTable, union } from 'drizzle-orm/pg-core';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
import {
  RgLimitExceededError,
  type GameAdapter,
  type GameGeoCheckPort,
  type GameGeoDecision,
  type GamingSetGameAvailabilityArgs,
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
  gameTag,
  gameTagGame,
  gameProvider,
  gameProviderAggregatorMapping,
  gameRound,
  type Game,
  type GameRound,
} from '../schema/index.js';
import { GameProviderNotFoundError } from './game-provider.service.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import { GameTagNotFoundError } from './game-tag.service.js';
import {
  GameCategoryRuleManagedError,
  diffMembership,
} from './game-category-membership.service.js';
import {
  categoriesByGameIds,
  categoryGameOrder,
  categoryRankTriggerIds,
  countWhere,
  isGamePlayable,
  markCategoriesRankDirty,
  markCategoriesRankDirtyForGames,
  playableGameCondition,
  tagsByGameIds,
  toCategorySummary,
  toGameTagSummary,
  type CatalogActor,
} from '../../shared/game-catalog.js';
import type { ListAdminGamesInput, ListGamesInput, UpdateGameInput } from '../contract/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

export const GameSlugTakenError = makeConflictError(
  'GameSlugTakenError',
  'A game with this slug already exists',
);

export const GameAggregatorNotMappedError = createDomainError<
  [providerId: string, aggregator: string]
>(
  'GameAggregatorNotMappedError',
  (providerId, aggregator) => `Provider ${providerId} has no mapping for aggregator ${aggregator}`,
);

export const RgRestrictedError = makeConflictError(
  'RgRestrictedError',
  'play is restricted by an active responsible-gambling exclusion',
);

export type GameGeoRestrictedData = Pick<
  Extract<GameGeoDecision, { allowed: false }>,
  'reason' | 'countryCode'
>;

export class GameGeoRestrictedError extends Error {
  readonly data: GameGeoRestrictedData;

  constructor(decision: Extract<GameGeoDecision, { allowed: false }>) {
    super(`Game cannot be started from this location (${decision.reason})`);
    this.name = 'GameGeoRestrictedError';
    this.data = { reason: decision.reason, countryCode: decision.countryCode };
  }
}

// GAME_GEO_CHECK is bound only when the compliance module is loaded; its absence is how
// listGamesAdmin detects the geo filters have nothing to query.
export const GameGeoFiltersUnavailableError = createDomainError<[]>(
  'GameGeoFiltersUnavailableError',
  () => 'geo filters are unavailable: the compliance module is not loaded',
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
  tags: (typeof gameTag.$inferSelect)[];
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
    categories: row.categories.map(toCategorySummary),
    tags: row.tags.map(toGameTagSummary),
    gameType: row.game.gameType,
    thumbnailUrl: row.game.thumbnailUrl,
    isActive: row.game.isActive,
    isUnavailable: row.game.isUnavailable,
    metadata: row.game.metadata,
  };
}

// Reads the links through the caller's transaction so the snapshot matches the
// locked row; ordered so identical link sets always serialize identically.
async function gameAuditSnapshot(tx: DrizzleTx, row: Game) {
  const [links, tagLinks] = await Promise.all([
    tx
      .select({ categoryId: gameCategoryGame.categoryId })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.gameId, row.id))
      .orderBy(asc(gameCategoryGame.categoryId)),
    tx
      .select({ tagId: gameTagGame.tagId })
      .from(gameTagGame)
      .where(eq(gameTagGame.gameId, row.id))
      .orderBy(asc(gameTagGame.tagId)),
  ]);
  return {
    slug: row.slug,
    name: row.name,
    providerId: row.providerId,
    aggregator: row.aggregator,
    thumbnailUrl: row.thumbnailUrl,
    isActive: row.isActive,
    categoryIds: links.map((link) => link.categoryId),
    tagIds: tagLinks.map((link) => link.tagId),
    metadata: row.metadata ?? null,
  };
}

function toGameRound(record: typeof gameRound.$inferSelect) {
  return serializeRow(record, { dateFields: ['startedAt', 'endedAt'] });
}

function withInactive<T extends { total: number; active: number }>(counts: T) {
  return { ...counts, inactive: counts.total - counts.active };
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
    private readonly gameGeoCheck?: GameGeoCheckPort,
  ) {}

  async listGamesPublic(input: ListGamesInput) {
    return this.listGames({
      ...input,
      playableOnly: true,
      sort: 'public',
      includeInvisibleTags: false,
    });
  }

  async listGamesAdmin({
    categoryIds,
    uncategorized,
    tagIds,
    gameTypes,
    geoBlocked,
    geoBlockedCountries,
    ...input
  }: ListAdminGamesInput) {
    if (!this.gameGeoCheck && (geoBlocked !== undefined || geoBlockedCountries)) {
      throw new GameGeoFiltersUnavailableError();
    }
    const db = this.drizzle.db;
    const anyCategory = this.rowsWhere({
      table: gameCategoryGame,
      column: gameCategoryGame.gameId,
      equals: game.id,
    });
    // A game counts as geo-blocked by its own rule or its provider's, matching the play gate's check.
    // Grouped by game id so the planner hashes distinct games, not one entry per rule row.
    const geoBlockedGameIds = db
      .select({ gameId: gameGeoRule.gameId })
      .from(gameGeoRule)
      .groupBy(gameGeoRule.gameId);
    const geoBlockedProviderIds = db
      .select({ providerId: providerGeoRule.providerId })
      .from(providerGeoRule);
    const anyGameGeoRule = this.rowsWhere({
      table: gameGeoRule,
      column: gameGeoRule.gameId,
      equals: game.id,
    });
    const anyProviderGeoRule = this.rowsWhere({
      table: providerGeoRule,
      column: providerGeoRule.providerId,
      equals: game.providerId,
    });
    return this.listGames({
      ...input,
      playableOnly: false,
      sort: 'admin',
      includeInvisibleTags: true,
      filters: [
        categoryIds
          ? this.linkedToAll({
              values: categoryIds,
              pairs: db
                .select({ gameId: gameCategoryGame.gameId, value: gameCategoryGame.categoryId })
                .from(gameCategoryGame)
                .where(inArray(gameCategoryGame.categoryId, categoryIds)),
            })
          : undefined,
        uncategorized === undefined
          ? undefined
          : uncategorized
            ? notExists(anyCategory)
            : exists(anyCategory),
        tagIds
          ? this.linkedToAll({
              values: tagIds,
              pairs: db
                .select({ gameId: gameTagGame.gameId, value: gameTagGame.tagId })
                .from(gameTagGame)
                .where(inArray(gameTagGame.tagId, tagIds)),
            })
          : undefined,
        gameTypes ? inArray(game.gameType, gameTypes) : undefined,
        geoBlocked === undefined
          ? undefined
          : geoBlocked
            ? or(
                inArray(game.id, geoBlockedGameIds),
                inArray(game.providerId, geoBlockedProviderIds),
              )
            : // NOT EXISTS, not NOT IN: the anti join keeps scaling with the rule table.
              and(notExists(anyGameGeoRule), notExists(anyProviderGeoRule)),
        geoBlockedCountries
          ? this.linkedToAll({
              values: geoBlockedCountries,
              pairs: union(
                db
                  .select({ gameId: gameGeoRule.gameId, value: gameGeoRule.countryCode })
                  .from(gameGeoRule)
                  .where(inArray(gameGeoRule.countryCode, geoBlockedCountries)),
                db
                  .select({ gameId: game.id, value: providerGeoRule.countryCode })
                  .from(providerGeoRule)
                  .innerJoin(game, eq(game.providerId, providerGeoRule.providerId))
                  .where(inArray(providerGeoRule.countryCode, geoBlockedCountries)),
              ),
            })
          : undefined,
      ],
    });
  }

  private rowsWhere({
    table,
    column,
    equals,
  }: {
    table: PgTable;
    column: PgColumn;
    equals: PgColumn;
  }) {
    return this.drizzle.db
      .select({ one: sql`1` })
      .from(table)
      .where(eq(column, equals));
  }

  private linkedToAll({ pairs, values }: { pairs: SQLWrapper; values: string[] }) {
    return inArray(
      game.id,
      sql`(select pairs.game_id from (${pairs}) as pairs(game_id, value) group by pairs.game_id having count(distinct pairs.value) = ${values.length})`,
    );
  }

  async getCatalogStats() {
    const db = this.drizzle.db;
    const [[providers], [categories], [games]] = await Promise.all([
      db
        .select({ total: count(), active: countWhere(eq(gameProvider.isActive, true)) })
        .from(gameProvider),
      db
        .select({ total: count(), active: countWhere(eq(gameCategory.isActive, true)) })
        .from(gameCategory),
      db
        .select({
          total: count(),
          active: countWhere(eq(game.isActive, true)),
          unavailable: countWhere(eq(game.isUnavailable, true)),
          playable: countWhere(playableGameCondition()),
        })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id)),
    ]);
    return {
      providers: withInactive(providers),
      categories: withInactive(categories),
      games: withInactive(games),
    };
  }

  private async listGames({
    page,
    limit,
    q,
    providerId,
    categoryId,
    isActive,
    isUnavailable,
    playableOnly,
    sort,
    includeInvisibleTags,
    filters = [],
  }: ListGamesInput & {
    isActive?: boolean;
    isUnavailable?: boolean;
    playableOnly: boolean;
    sort: 'admin' | 'public';
    includeInvisibleTags: boolean;
    filters?: (SQL | undefined)[];
  }) {
    // The public route orders a category listing by the category's configured sort
    // (categoryGameOrder, shared with GAME_CATALOG_READER so the two never drift), via
    // an inner join on the membership row itself. The admin list keeps its exists-based
    // membership check and name order unchanged - it never reads rank or position.
    const usePublicCategoryJoin = sort === 'public' && categoryId !== undefined;
    const where = and(
      ...filters,
      q
        ? or(
            ilike(game.name, likeContains(q)),
            ilike(game.slug, likeContains(q)),
            ilike(gameProvider.name, likeContains(q)),
          )
        : undefined,
      providerId ? eq(game.providerId, providerId) : undefined,
      playableOnly
        ? playableGameCondition()
        : isActive === undefined
          ? undefined
          : eq(game.isActive, isActive),
      isUnavailable !== undefined ? eq(game.isUnavailable, isUnavailable) : undefined,
      categoryId !== undefined && !usePublicCategoryJoin
        ? exists(
            this.drizzle.db
              .select({ gameId: gameCategoryGame.gameId })
              .from(gameCategoryGame)
              .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
              .where(
                and(
                  eq(gameCategoryGame.gameId, game.id),
                  eq(gameCategoryGame.categoryId, categoryId),
                  playableOnly ? eq(gameCategory.isActive, true) : undefined,
                ),
              ),
          )
        : undefined,
      categoryId !== undefined && usePublicCategoryJoin
        ? eq(gameCategoryGame.categoryId, categoryId)
        : undefined,
      usePublicCategoryJoin ? eq(gameCategory.isActive, true) : undefined,
    );
    const orderBy = usePublicCategoryJoin
      ? categoryGameOrder()
      : sort === 'admin'
        ? [asc(gameProvider.name), asc(gameProvider.slug), asc(game.name), asc(game.id)]
        : [asc(game.name)];
    const gamesQuery = this.drizzle.db
      .select({ game, provider: gameProvider })
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id));
    const countQuery = this.drizzle.db
      .select({ n: count() })
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id));
    const [rows, [{ n }]] = usePublicCategoryJoin
      ? await Promise.all([
          gamesQuery
            .innerJoin(gameCategoryGame, eq(gameCategoryGame.gameId, game.id))
            .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(pageToOffset(page, limit)),
          countQuery
            .innerJoin(gameCategoryGame, eq(gameCategoryGame.gameId, game.id))
            .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
            .where(where),
        ])
      : await Promise.all([
          gamesQuery
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(pageToOffset(page, limit)),
          countQuery.where(where),
        ]);
    const [categories, tags] = await Promise.all([
      categoriesByGameIds(
        this.drizzle.db,
        rows.map((r) => r.game.id),
        playableOnly,
      ),
      tagsByGameIds(
        this.drizzle.db,
        rows.map((r) => r.game.id),
        {
          includeInvisible: includeInvisibleTags,
        },
      ),
    ]);
    return {
      items: rows.map((r) =>
        toGame({
          ...r,
          categories: categories.get(r.game.id) ?? [],
          tags: tags.get(r.game.id) ?? [],
        }),
      ),
      total: Number(n),
      page,
      limit,
    };
  }

  async getGame(
    id: Game['id'],
    opts: { activeOnly?: boolean; includeInvisibleTags?: boolean } = {},
  ) {
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
    const [categories, tags] = await Promise.all([
      categoriesByGameIds(this.drizzle.db, [row.game.id], opts.activeOnly),
      tagsByGameIds(this.drizzle.db, [row.game.id], {
        includeInvisible: opts.includeInvisibleTags,
      }),
    ]);
    return toGame({
      ...row,
      categories: categories.get(row.game.id) ?? [],
      tags: tags.get(row.game.id) ?? [],
    });
  }

  async startRound(
    userId: User['id'],
    gameId: Game['id'],
    currency: string,
    betAmount: string,
    ipAddress: string | null = null,
  ) {
    await this.getGame(gameId, { activeOnly: true });

    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }
    const decision = await this.rgLimits?.checkWager(this.drizzle.db, userId, betAmount, currency);
    if (decision && !decision.allowed) {
      throw new RgLimitExceededError('wager_limit_exceeded', decision);
    }

    const geoDecision = await this.gameGeoCheck?.checkGame({
      gameId,
      ipAddress,
    });
    if (geoDecision && !geoDecision.allowed) {
      throw new GameGeoRestrictedError(geoDecision);
    }

    const { round, completedBonusCredits, betTransactionId } = await this.drizzle.db.transaction(
      async (tx) => {
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
        const moved = outcome.moved ? outcome : undefined;
        return {
          round: insertedRound,
          completedBonusCredits: moved?.completedBonusCredits ?? [],
          betTransactionId: moved?.transactionId,
        };
      },
    );

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);

    // Emitted only after the transaction above committed - see the module-level comment
    // on WalletCommandsService for why the port itself never emits this.
    if (betTransactionId) {
      this.events.emit('wallet.balance.changed', {
        userId,
        playerId,
        amount: betAmount,
        currency,
        transactionId: betTransactionId,
        type: 'bet',
        direction: 'debit',
      });
    }

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
      playerId,
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

    const { paid, winTransactionId } = await this.drizzle.db.transaction(async (tx) => {
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
        return { paid: false, winTransactionId: undefined };
      }
      let winTransactionId: string | undefined;
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
        winTransactionId = credited.moved ? credited.transactionId : undefined;
      }
      return { paid: true, winTransactionId };
    });

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);

    // Emitted only after the transaction above committed - see the module-level comment
    // on WalletCommandsService for why the port itself never emits this.
    if (winTransactionId) {
      this.events.emit('wallet.balance.changed', {
        userId,
        playerId,
        amount: winAmount,
        currency: round.currency,
        transactionId: winTransactionId,
        type: 'win',
        direction: 'credit',
      });
    }

    this.events.emit('gaming.round.ended', {
      roundId,
      userId,
      playerId,
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

  async setGameAvailability({ gameId, isUnavailable }: GamingSetGameAvailabilityArgs) {
    const changed = await this.drizzle.db.transaction(async (tx) => {
      const current = findOneOrThrow(
        await tx
          .select({ isUnavailable: game.isUnavailable })
          .from(game)
          .where(eq(game.id, gameId))
          .limit(1)
          .for('update'),
        new GameNotFoundError(gameId),
      );
      if (current.isUnavailable === isUnavailable) {
        return false;
      }
      await tx.update(game).set({ isUnavailable }).where(eq(game.id, gameId));
      // Flips a game's playable/unplayable split within any category it's in - a pinned
      // slot's meaning depends on that split, so it must re-rank too. See docs/modules/gaming.md.
      await markCategoriesRankDirtyForGames(tx, [gameId]);
      return true;
    });
    if (changed) {
      this.events.emit('gaming.game.availability_changed', {
        gameId,
        before: { isUnavailable: !isUnavailable },
        after: { isUnavailable },
      });
    }
    return { changed };
  }

  async updateGame({
    id,
    categoryIds,
    tagIds,
    actorId,
    ip,
    userAgent,
    ...patchInput
  }: UpdateGameInput & CatalogActor) {
    const uniqueCategoryIds = categoryIds === undefined ? undefined : [...new Set(categoryIds)];
    const uniqueTagIds = tagIds === undefined ? undefined : [...new Set(tagIds)];
    const patch: Partial<typeof game.$inferInsert> = { ...patchInput };
    const hasScalarChanges = Object.values(patch).some((value) => value !== undefined);
    if (!hasScalarChanges && uniqueCategoryIds === undefined && uniqueTagIds === undefined) {
      return this.getGame(id, { includeInvisibleTags: true });
    }
    const transition = await this.drizzle.db
      .transaction(async (tx) => {
        // The row lock serializes concurrent PATCHes, so the audited `before` is the
        // state this write replaced and `after` is what it persisted (docs/standards/audit.md).
        const beforeRow = findOneOrThrow(
          await tx.select().from(game).where(eq(game.id, id)).limit(1).for('update'),
          new GameNotFoundError(id),
        );
        const before = await gameAuditSnapshot(tx, beforeRow);
        if (patchInput.providerId !== undefined || patchInput.aggregator !== undefined) {
          const nextProviderId = patchInput.providerId ?? beforeRow.providerId;
          const nextAggregator = patchInput.aggregator ?? beforeRow.aggregator;
          // FOR SHARE conflicts with updateProvider's FOR UPDATE, so the mapping checked
          // below cannot be removed until this game has committed against it.
          findOneOrThrow(
            await tx
              .select({ id: gameProvider.id })
              .from(gameProvider)
              .where(eq(gameProvider.id, nextProviderId))
              .limit(1)
              .for('share'),
            new GameProviderNotFoundError(nextProviderId),
          );
          const [mapping] = await tx
            .select({ id: gameProviderAggregatorMapping.id })
            .from(gameProviderAggregatorMapping)
            .where(
              and(
                eq(gameProviderAggregatorMapping.providerId, nextProviderId),
                eq(gameProviderAggregatorMapping.aggregator, nextAggregator),
              ),
            )
            .limit(1);
          if (!mapping) {
            throw new GameAggregatorNotMappedError(nextProviderId, nextAggregator);
          }
        }
        if (patchInput.slug !== undefined) {
          const [clash] = await tx
            .select({ id: game.id })
            .from(game)
            .where(and(eq(game.slug, patchInput.slug), ne(game.id, id)))
            .limit(1);
          if (clash) {
            throw new GameSlugTakenError();
          }
        }
        const categoryDiff =
          uniqueCategoryIds === undefined
            ? { toAdd: [], toRemove: [] }
            : diffMembership(before.categoryIds, uniqueCategoryIds);
        if (uniqueCategoryIds !== undefined) {
          // FOR KEY SHARE here conflicts with the FOR UPDATE a mode switch or the rule
          // evaluator takes - see "Lock order" in docs/modules/gaming.md.
          const lookupIds = [...new Set([...uniqueCategoryIds, ...categoryDiff.toRemove])].sort();
          const rows =
            lookupIds.length > 0
              ? await tx
                  .select({ id: gameCategory.id, membershipMode: gameCategory.membershipMode })
                  .from(gameCategory)
                  .where(inArray(gameCategory.id, lookupIds))
                  .orderBy(asc(gameCategory.id))
                  .for('key share')
              : [];
          const modeById = new Map(rows.map((r) => [r.id, r.membershipMode]));
          const missing = uniqueCategoryIds.find((categoryId) => !modeById.has(categoryId));
          if (missing) {
            throw new GameCategoryNotFoundError(missing);
          }
          // Re-sending a rule-mode category the game is already in is not a change.
          const ruleManaged = [...categoryDiff.toAdd, ...categoryDiff.toRemove].find(
            (categoryId) => modeById.get(categoryId) === 'rule',
          );
          if (ruleManaged) {
            throw new GameCategoryRuleManagedError(ruleManaged);
          }
        }
        if (uniqueTagIds !== undefined) {
          const rows =
            uniqueTagIds.length > 0
              ? await tx
                  .select({ id: gameTag.id })
                  .from(gameTag)
                  .where(inArray(gameTag.id, uniqueTagIds))
                  .for('key share')
              : [];
          const found = new Set(rows.map((r) => r.id));
          const missing = uniqueTagIds.find((tagId) => !found.has(tagId));
          if (missing) {
            throw new GameTagNotFoundError(missing);
          }
        }
        // Marks the trigger categories dirty (locking `game_category`) before touching
        // `game_category_game` below - `GameSortRankingService.finalize` locks
        // `game_category` FOR UPDATE first and only then writes `game_category_game`
        // for that category, so writing the two tables in the opposite order here would
        // be an ABBA lock-order inversion Postgres resolves by aborting one side (see
        // docs/modules/gaming.md). The trigger set is computed from the anticipated
        // post-write values (the patch already validated above), not a re-read after
        // the write, precisely so this can run before any category-membership write.
        const anticipatedAfterCategoryIds = uniqueCategoryIds ?? before.categoryIds;
        await markCategoriesRankDirty(
          tx,
          categoryRankTriggerIds(
            {
              name: beforeRow.name,
              isActive: beforeRow.isActive,
              providerId: beforeRow.providerId,
              categoryIds: before.categoryIds,
            },
            {
              name: patch.name ?? beforeRow.name,
              providerId: patch.providerId ?? beforeRow.providerId,
              isActive: patch.isActive ?? beforeRow.isActive,
              categoryIds: anticipatedAfterCategoryIds,
            },
          ),
        );
        if (hasScalarChanges) {
          await tx.update(game).set(patch).where(eq(game.id, id));
        }
        // Only the links that moved are written: a kept link - a rule-mode category's
        // above all - keeps its row, and with it its source, position and pin.
        if (categoryDiff.toRemove.length > 0) {
          await tx
            .delete(gameCategoryGame)
            .where(
              and(
                eq(gameCategoryGame.gameId, id),
                inArray(gameCategoryGame.categoryId, categoryDiff.toRemove),
              ),
            );
        }
        if (categoryDiff.toAdd.length > 0) {
          await tx
            .insert(gameCategoryGame)
            .values(categoryDiff.toAdd.map((categoryId) => ({ gameId: id, categoryId })));
        }
        if (uniqueTagIds !== undefined) {
          await tx.delete(gameTagGame).where(eq(gameTagGame.gameId, id));
          if (uniqueTagIds.length > 0) {
            await tx
              .insert(gameTagGame)
              .values(uniqueTagIds.map((tagId) => ({ gameId: id, tagId })));
          }
        }
        const afterRow = findOneOrThrow(
          await tx.select().from(game).where(eq(game.id, id)).limit(1),
          new GameNotFoundError(id),
        );
        const after = await gameAuditSnapshot(tx, afterRow);
        return { before, after };
      })
      .catch((error: unknown) => {
        // The transaction also writes category and tag links: only a slug collision maps
        // to GameSlugTakenError, a link race must not masquerade as one.
        if (uniqueConstraintName(error) === 'game_slug_key') {
          throw new GameSlugTakenError();
        }
        throw error;
      });
    this.events.emit('gaming.game.updated', {
      gameId: id,
      actorId,
      before: transition.before,
      after: transition.after,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return this.getGame(id, { includeInvisibleTags: true });
  }
}
