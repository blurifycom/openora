import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  DrizzleService,
  makeConflictError,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  GAME_BULK_CAP,
  GameBulkTooManyGamesError,
  type GameAddedCategoryLinks,
  type GameAddedTagLinks,
  type GameProviderAggregatorMapping,
  type GameReviewStatus,
} from '@openora/core/contracts';
import { game, gameCategory, gameProvider, gameTag } from '../schema/index.js';
import {
  isUnreviewed,
  mappingsByProviderIds,
  markCategoriesRankDirty,
  markCategoriesRankDirtyForGames,
  markCategoriesRankDirtyForProviders,
  pendingReviewCondition,
  type CatalogActor,
} from '../../shared/game-catalog.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import { GameTagNotFoundError } from './game-tag.service.js';
import { GameCategoryRuleManagedError } from './game-category-membership.service.js';
import { providerSnapshot } from './game-provider.service.js';
import { GameNotFoundError } from './gaming.service.js';
import type {
  AddGameCategoriesInput,
  AddGameTagsInput,
  ReviewGameInput,
  ReviewGamesInput,
  SetGamesActiveInput,
} from '../contract/index.js';

export const GameNotPendingReviewError = makeConflictError(
  'GameNotPendingReviewError',
  'Only a pending game can be reviewed',
);

class ScopeChangedDuringLockError extends Error {}

const MAX_SCOPE_ATTEMPTS = 5;

// Postgres returns uuids lowercase; an uppercase input id would never match its row.
function dedupe(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids.map((id) => id.toLowerCase()))] : [];
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

// `providerGameFilter` narrows only the provider-scope games; a game named by id always matches.
function targetCondition(gameIds: string[], providerIds: string[], providerGameFilter?: SQL) {
  return or(
    gameIds.length > 0 ? inArray(game.id, gameIds) : undefined,
    providerIds.length > 0
      ? and(inArray(game.providerId, providerIds), providerGameFilter)
      : undefined,
  );
}

/**
 * Bulk catalog writes over `gameIds` and/or every game of `providerIds`. Unknown game or
 * provider ids are returned in `notFound` while the rest applies; an unknown tag or
 * category id rejects the whole call. Throws `GameBulkTooManyGamesError` past 5,000 games.
 */
export class GameBulkService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  private async assertWithinGameCap(tx: DrizzleTx, condition: SQL | undefined) {
    const [row] = await tx.select({ n: count() }).from(game).where(condition);
    const matched = Number(row?.n ?? 0);
    if (matched > GAME_BULK_CAP) {
      throw new GameBulkTooManyGamesError(matched, GAME_BULK_CAP);
    }
  }

  private async resolveGameScope(
    tx: DrizzleTx,
    {
      gameIds,
      providerIds,
      gameLockMode,
      providerGameFilter,
    }: {
      gameIds: string[];
      providerIds: string[];
      gameLockMode: 'update' | 'key share';
      providerGameFilter?: SQL;
    },
  ) {
    const condition = targetCondition(gameIds, providerIds, providerGameFilter);
    for (let attempt = 0; attempt < MAX_SCOPE_ATTEMPTS; attempt++) {
      try {
        return await tx.transaction(async (tx2) => {
          const games = await tx2
            .select({
              id: game.id,
              isActive: game.isActive,
              providerId: game.providerId,
              reviewStatus: game.reviewStatus,
            })
            .from(game)
            .where(condition)
            .orderBy(asc(game.id))
            .for(gameLockMode);

          let providerRows: (typeof gameProvider.$inferSelect)[] = [];
          if (providerIds.length > 0) {
            providerRows = await tx2
              .select()
              .from(gameProvider)
              .where(inArray(gameProvider.id, providerIds))
              .orderBy(asc(gameProvider.id))
              .for('update');
          }

          // Under READ COMMITTED the locking scan above skips a game an uncommitted updateGame
          // is moving onto these providers; once it commits, only a fresh read sees it.
          if (providerRows.length > 0) {
            const lockedIds = new Set(games.map((row) => row.id));
            const currentlyUnderLockedProviders = await tx2
              .select({ id: game.id })
              .from(game)
              .where(
                and(
                  inArray(
                    game.providerId,
                    providerRows.map((row) => row.id),
                  ),
                  providerGameFilter,
                ),
              );
            if (currentlyUnderLockedProviders.some((row) => !lockedIds.has(row.id))) {
              throw new ScopeChangedDuringLockError();
            }
          }

          const foundGameIds = new Set(games.map((row) => row.id));
          const notFoundGameIds = sortIds(gameIds.filter((id) => !foundGameIds.has(id)));
          const foundProviderIds = new Set(providerRows.map((row) => row.id));
          const notFoundProviderIds = sortIds(
            providerIds.filter((id) => !foundProviderIds.has(id)),
          );

          return { games, providerRows, notFoundGameIds, notFoundProviderIds };
        });
      } catch (error) {
        if (error instanceof ScopeChangedDuringLockError) {
          continue;
        }
        throw error;
      }
    }
    throw new ScopeChangedDuringLockError();
  }

  async setGamesActive({
    isActive,
    actorId,
    ip,
    userAgent,
    ...target
  }: SetGamesActiveInput & CatalogActor) {
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);
    const bulkOperationId = randomUUID();

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);
      const { games, providerRows, notFoundGameIds, notFoundProviderIds } =
        await this.resolveGameScope(tx, { gameIds, providerIds, gameLockMode: 'update' });
      const existingProviderIds = providerRows.map((row) => row.id);

      const mappingsByProvider =
        existingProviderIds.length > 0
          ? await mappingsByProviderIds(tx, existingProviderIds)
          : new Map<string, GameProviderAggregatorMapping[]>();

      let changedProviderIds: string[] = [];
      if (existingProviderIds.length > 0) {
        const rows = await tx
          .update(gameProvider)
          .set({ isActive })
          .where(
            and(inArray(gameProvider.id, existingProviderIds), ne(gameProvider.isActive, isActive)),
          )
          .returning({ id: gameProvider.id });
        changedProviderIds = rows.map((row) => row.id);
      }
      const changedProviderIdSet = new Set(changedProviderIds);
      const changedProviderSnapshots = providerRows
        .filter((row) => changedProviderIdSet.has(row.id))
        .map((row) => {
          const mappings = mappingsByProvider.get(row.id) ?? [];
          return {
            providerId: row.id,
            before: providerSnapshot(row, mappings),
            after: providerSnapshot({ ...row, isActive }, mappings),
          };
        });

      // Enabling an unreviewed game named by id approves it; a provider-scope enable
      // leaves it off, since nobody looked at that game.
      const namedGameIds = new Set(gameIds);
      const toFlip = games.filter((row) => row.isActive !== isActive);
      const unreviewed = isActive ? toFlip.filter((row) => isUnreviewed(row.reviewStatus)) : [];
      const toApprove = unreviewed.filter((row) => namedGameIds.has(row.id));
      const reviewSkipped = unreviewed.filter((row) => !namedGameIds.has(row.id));
      const reviewSkippedIds = new Set(reviewSkipped.map((row) => row.id));
      const approvedIds = new Set(toApprove.map((row) => row.id));
      const toPlainFlip = toFlip
        .filter((row) => !reviewSkippedIds.has(row.id) && !approvedIds.has(row.id))
        .map((row) => row.id);
      const changedGameIds: string[] = [];
      if (toPlainFlip.length > 0) {
        const rows = await tx
          .update(game)
          .set({ isActive })
          .where(inArray(game.id, toPlainFlip))
          .returning({ id: game.id });
        changedGameIds.push(...rows.map((row) => row.id));
      }
      const approvedGameIds = await approveGames(
        tx,
        toApprove.map((row) => row.id),
      );
      changedGameIds.push(...approvedGameIds);

      const unplayableGameIds = isActive
        ? await unplayableAmong(tx, and(condition, eq(game.isActive, true)))
        : [];

      // A flipped game or provider moves its categories' playable/unplayable split -
      // pins are placed relative to it, so those categories must re-rank. See docs/modules/gaming.md.
      // The ids come back from the marker itself so plugin.ts's fast-path enqueue can
      // reuse them instead of resolving the same lookup a second time after commit.
      const dirtiedByGames = await markCategoriesRankDirtyForGames(tx, changedGameIds);
      const dirtiedByProviders = await markCategoriesRankDirtyForProviders(tx, changedProviderIds);

      return {
        gameIds,
        providerIds,
        notFoundGameIds,
        notFoundProviderIds,
        changedGameIds: sortIds(changedGameIds),
        changedProviderIds: sortIds(changedProviderIds),
        changedProviderSnapshots,
        dirtiedCategoryIds: sortIds([...new Set([...dirtiedByGames, ...dirtiedByProviders])]),
        gamesUpdatedCount: changedGameIds.length,
        gamesUnchangedCount: games.length - changedGameIds.length - reviewSkipped.length,
        providersUpdatedCount: changedProviderIds.length,
        providersUnchangedCount: existingProviderIds.length - changedProviderIds.length,
        unplayableGameIds,
        reviewSkippedCount: reviewSkipped.length,
        approvedByStatus: groupIdsByStatus(toApprove, new Set(approvedGameIds)),
      };
    });

    if (outcome.changedGameIds.length > 0 || outcome.changedProviderIds.length > 0) {
      this.events.emit('gaming.games.bulk_updated', {
        operation: 'set_active',
        actorId,
        bulkOperationId,
        target: { gameIds: outcome.gameIds, providerIds: outcome.providerIds },
        isActive,
        changedGameIds: outcome.changedGameIds,
        changedProviderIds: outcome.changedProviderIds,
        affectedCategoryIds: outcome.dirtiedCategoryIds,
        notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    for (const snapshot of outcome.changedProviderSnapshots) {
      this.events.emit('gaming.provider.updated', {
        providerId: snapshot.providerId,
        actorId,
        bulkOperationId,
        before: snapshot.before,
        after: snapshot.after,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    for (const [previousStatus, approvedIds] of outcome.approvedByStatus) {
      this.events.emit('gaming.games.reviewed', {
        actorId,
        decision: 'approve',
        previousStatus,
        gameIds: approvedIds,
        bulkOperationId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }

    return {
      games: {
        updatedCount: outcome.gamesUpdatedCount,
        unchangedCount: outcome.gamesUnchangedCount,
      },
      providers: {
        updatedCount: outcome.providersUpdatedCount,
        unchangedCount: outcome.providersUnchangedCount,
      },
      notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
      unplayableGameIds: outcome.unplayableGameIds,
      reviewSkippedCount: outcome.reviewSkippedCount,
    };
  }

  /** Moves pending games only: a named game in any other status counts as unchanged. */
  async reviewGames({
    decision,
    actorId,
    ip,
    userAgent,
    ...target
  }: ReviewGamesInput & CatalogActor) {
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const pending = pendingReviewCondition();
    const condition = targetCondition(gameIds, providerIds, pending);
    const bulkOperationId = randomUUID();

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);
      const { games, notFoundGameIds, notFoundProviderIds } = await this.resolveGameScope(tx, {
        gameIds,
        providerIds,
        gameLockMode: 'update',
        providerGameFilter: pending,
      });
      const pendingIds = games.filter((row) => row.reviewStatus === 'pending').map((row) => row.id);
      let changedGameIds: string[] = [];
      let dirtiedCategoryIds: string[] = [];
      let unplayableGameIds: string[] = [];
      if (decision === 'approve') {
        changedGameIds = await approveGames(tx, pendingIds);
        // Approving makes the game live, the same split move an enable makes.
        dirtiedCategoryIds = await markCategoriesRankDirtyForGames(tx, changedGameIds);
        unplayableGameIds =
          changedGameIds.length > 0
            ? await unplayableAmong(tx, inArray(game.id, changedGameIds))
            : [];
      } else if (pendingIds.length > 0) {
        const rows = await tx
          .update(game)
          .set({ reviewStatus: 'declined', reviewedAt: new Date() })
          .where(inArray(game.id, pendingIds))
          .returning({ id: game.id });
        changedGameIds = rows.map((row) => row.id);
      }
      return {
        notFoundGameIds,
        notFoundProviderIds,
        changedGameIds: sortIds(changedGameIds),
        dirtiedCategoryIds: sortIds(dirtiedCategoryIds),
        unchangedCount: games.length - changedGameIds.length,
        unplayableGameIds,
      };
    });

    const notFound = { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds };
    if (outcome.changedGameIds.length > 0) {
      if (decision === 'approve') {
        this.events.emit('gaming.games.bulk_updated', {
          operation: 'set_active',
          actorId,
          bulkOperationId,
          target: { gameIds, providerIds },
          isActive: true,
          changedGameIds: outcome.changedGameIds,
          changedProviderIds: [],
          affectedCategoryIds: outcome.dirtiedCategoryIds,
          notFound,
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }
      this.events.emit('gaming.games.reviewed', {
        actorId,
        decision,
        previousStatus: 'pending',
        gameIds: outcome.changedGameIds,
        bulkOperationId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }

    return {
      games: {
        updatedCount: outcome.changedGameIds.length,
        unchangedCount: outcome.unchangedCount,
      },
      notFound,
      unplayableGameIds: outcome.unplayableGameIds,
    };
  }

  async reviewGame({ id, ...input }: ReviewGameInput & CatalogActor) {
    const result = await this.reviewGames({ ...input, gameIds: [id] });
    if (result.notFound.gameIds.length > 0) {
      throw new GameNotFoundError(id);
    }
    if (result.games.updatedCount === 0) {
      throw new GameNotPendingReviewError();
    }
  }

  async addGameTags({
    tagIds: rawTagIds,
    actorId,
    ip,
    userAgent,
    ...target
  }: AddGameTagsInput & CatalogActor) {
    const tagIds = sortIds(dedupe(rawTagIds));
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);

      // The link insert's foreign-key check takes FOR KEY SHARE on each game row anyway;
      // taking it up front, in id order and before provider locks, avoids a deadlock.
      const { games, notFoundGameIds, notFoundProviderIds } = await this.resolveGameScope(tx, {
        gameIds,
        providerIds,
        gameLockMode: 'key share',
      });

      const foundTags = await tx
        .select({ id: gameTag.id })
        .from(gameTag)
        .where(inArray(gameTag.id, tagIds))
        .for('key share');
      const foundTagIds = new Set(foundTags.map((row) => row.id));
      const missingTagId = tagIds.find((id) => !foundTagIds.has(id));
      if (missingTagId) {
        throw new GameTagNotFoundError(missingTagId);
      }

      const matchedGameIds = games.map((row) => row.id);
      let addedLinks: GameAddedTagLinks = [];
      if (matchedGameIds.length > 0) {
        // Array parameters keep the insert under Postgres' 65,535 bind-parameter limit.
        const { rows } = await tx.execute<{ game_id: string; tag_id: string }>(sql`
          INSERT INTO game_tag_game (game_id, tag_id)
          SELECT g, t
          FROM unnest(${sql.param(matchedGameIds)}::uuid[]) AS g
          CROSS JOIN unnest(${sql.param(tagIds)}::uuid[]) AS t
          ON CONFLICT (game_id, tag_id) DO NOTHING
          RETURNING game_id, tag_id
        `);
        addedLinks = groupAddedLinks(rows, 'tag_id', 'tagIds');
      }

      const changedGameIds = addedLinks.map((link) => link.gameId);
      return {
        gameIds,
        providerIds,
        notFoundGameIds,
        notFoundProviderIds,
        addedLinks,
        gamesUpdatedCount: changedGameIds.length,
        gamesUnchangedCount: matchedGameIds.length - changedGameIds.length,
      };
    });

    if (outcome.addedLinks.length > 0) {
      this.events.emit('gaming.games.bulk_updated', {
        operation: 'add_tags',
        actorId,
        target: { gameIds: outcome.gameIds, providerIds: outcome.providerIds },
        tagIds,
        addedLinks: outcome.addedLinks,
        notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }

    return {
      games: {
        updatedCount: outcome.gamesUpdatedCount,
        unchangedCount: outcome.gamesUnchangedCount,
      },
      notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
    };
  }

  async addGameCategories({
    categoryIds: rawCategoryIds,
    actorId,
    ip,
    userAgent,
    ...target
  }: AddGameCategoriesInput & CatalogActor) {
    const categoryIds = sortIds(dedupe(rawCategoryIds));
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);

      // The link insert's foreign-key check takes FOR KEY SHARE on each game row anyway;
      // taking it up front, in id order and before provider locks, avoids a deadlock.
      const { games, notFoundGameIds, notFoundProviderIds } = await this.resolveGameScope(tx, {
        gameIds,
        providerIds,
        gameLockMode: 'key share',
      });

      const foundCategories = await tx
        .select({ id: gameCategory.id, membershipMode: gameCategory.membershipMode })
        .from(gameCategory)
        .where(inArray(gameCategory.id, categoryIds))
        .for('key share');
      const foundCategoryIds = new Set(foundCategories.map((row) => row.id));
      const missingCategoryId = categoryIds.find((id) => !foundCategoryIds.has(id));
      if (missingCategoryId) {
        throw new GameCategoryNotFoundError(missingCategoryId);
      }
      // The whole call is rejected, like an unknown category id: a rule-mode category's
      // games are the evaluator's alone. The key-share lock above holds off a concurrent
      // switch to rule mode until these links have committed.
      const ruleManaged = foundCategories.find((row) => row.membershipMode === 'rule');
      if (ruleManaged) {
        throw new GameCategoryRuleManagedError(ruleManaged.id);
      }

      const matchedGameIds = games.map((row) => row.id);
      let addedLinks: GameAddedCategoryLinks = [];
      if (matchedGameIds.length > 0) {
        // Marks every target category dirty (locking `game_category`) before inserting
        // into `game_category_game` below - GameSortRankingService.finalize locks
        // `game_category` FOR UPDATE first and only then writes `game_category_game`,
        // so writing the two tables in the opposite order (as this used to, marking
        // dirty only after the insert) is an ABBA lock-order inversion Postgres resolves
        // by aborting one side. Every requested category is marked, not only ones that
        // gain a genuinely new link - the categories are already known to exist (checked
        // above) and an extra dirty mark is a harmless no-op re-rank. See
        // docs/modules/gaming.md.
        await markCategoriesRankDirty(tx, categoryIds);
        const { rows } = await tx.execute<{ game_id: string; category_id: string }>(sql`
          INSERT INTO game_category_game (game_id, category_id)
          SELECT g, c
          FROM unnest(${sql.param(matchedGameIds)}::uuid[]) AS g
          CROSS JOIN unnest(${sql.param(categoryIds)}::uuid[]) AS c
          ON CONFLICT (game_id, category_id) DO NOTHING
          RETURNING game_id, category_id
        `);
        addedLinks = groupAddedLinks(rows, 'category_id', 'categoryIds');
      }

      const changedGameIds = addedLinks.map((link) => link.gameId);
      return {
        gameIds,
        providerIds,
        notFoundGameIds,
        notFoundProviderIds,
        addedLinks,
        gamesUpdatedCount: changedGameIds.length,
        gamesUnchangedCount: matchedGameIds.length - changedGameIds.length,
      };
    });

    if (outcome.addedLinks.length > 0) {
      this.events.emit('gaming.games.bulk_updated', {
        operation: 'add_categories',
        actorId,
        target: { gameIds: outcome.gameIds, providerIds: outcome.providerIds },
        categoryIds,
        addedLinks: outcome.addedLinks,
        notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }

    return {
      games: {
        updatedCount: outcome.gamesUpdatedCount,
        unchangedCount: outcome.gamesUnchangedCount,
      },
      notFound: { gameIds: outcome.notFoundGameIds, providerIds: outcome.notFoundProviderIds },
    };
  }
}

async function approveGames(tx: DrizzleTx, gameIds: string[]) {
  if (gameIds.length === 0) {
    return [];
  }
  const rows = await tx
    .update(game)
    .set({ isActive: true, reviewStatus: 'approved', reviewedAt: new Date() })
    .where(inArray(game.id, gameIds))
    .returning({ id: game.id });
  return rows.map((row) => row.id);
}

// Active games the player still cannot reach because their provider is off.
async function unplayableAmong(tx: DrizzleTx, condition: SQL | undefined) {
  const rows = await tx
    .select({ id: game.id })
    .from(game)
    .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
    .where(and(condition, eq(gameProvider.isActive, false)));
  return sortIds(rows.map((row) => row.id));
}

function groupIdsByStatus(
  rows: readonly { id: string; reviewStatus: GameReviewStatus }[],
  keep: ReadonlySet<string>,
) {
  const grouped = new Map<'pending' | 'declined', string[]>();
  for (const row of rows) {
    if (keep.has(row.id) && isUnreviewed(row.reviewStatus)) {
      const ids = grouped.get(row.reviewStatus) ?? [];
      ids.push(row.id);
      grouped.set(row.reviewStatus, ids);
    }
  }
  return [...grouped].map(([status, ids]) => [status, sortIds(ids)] as const);
}

function groupAddedLinks<K extends string>(
  rows: Array<{ game_id: string } & Record<string, string>>,
  linkColumn: string,
  linkKey: K,
): Array<{ gameId: string } & Record<K, string[]>> {
  const byGame = new Map<string, string[]>();
  for (const row of rows) {
    const linkId = row[linkColumn] as string;
    const list = byGame.get(row.game_id);
    if (list) {
      list.push(linkId);
    } else {
      byGame.set(row.game_id, [linkId]);
    }
  }
  return [...byGame.entries()]
    .map(
      ([gameId, linkIds]) =>
        ({ gameId, [linkKey]: sortIds(linkIds) }) as { gameId: string } & Record<K, string[]>,
    )
    .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));
}
