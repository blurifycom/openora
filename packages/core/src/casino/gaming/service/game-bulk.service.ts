import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  createDomainError,
  DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type { GameProviderAggregatorMapping } from '@openora/core/contracts';
import { game, gameCategory, gameProvider, gameTag } from '../schema/index.js';
import { mappingsByProviderIds, type CatalogActor } from '../../shared/game-catalog.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import { GameTagNotFoundError } from './game-tag.service.js';
import { providerSnapshot } from './game-provider.service.js';
import type {
  BulkAddGameCategoriesInput,
  BulkAddGameTagsInput,
  BulkSetGamesActiveInput,
} from '../contract/index.js';

const GAME_BULK_CAP = 5000;

export const GameBulkTooManyGamesError = createDomainError<[matchedCount: number, cap: number]>(
  'GameBulkTooManyGamesError',
  (matchedCount, cap) => `bulk action matched ${matchedCount} games, exceeding the ${cap}-game cap`,
);

class ScopeChangedDuringLockError extends Error {}

const MAX_SCOPE_ATTEMPTS = 5;

function dedupe(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids)] : [];
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function targetCondition(gameIds: string[], providerIds: string[]) {
  return or(
    gameIds.length > 0 ? inArray(game.id, gameIds) : undefined,
    providerIds.length > 0 ? inArray(game.providerId, providerIds) : undefined,
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
    gameIds: string[],
    providerIds: string[],
    gameLockMode: 'update' | 'key share',
  ) {
    const condition = targetCondition(gameIds, providerIds);
    for (let attempt = 0; attempt < MAX_SCOPE_ATTEMPTS; attempt++) {
      try {
        return await tx.transaction(async (tx2) => {
          const games = await tx2
            .select({ id: game.id, isActive: game.isActive, providerId: game.providerId })
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
                inArray(
                  game.providerId,
                  providerRows.map((row) => row.id),
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

  async bulkSetGamesActive({
    isActive,
    actorId,
    ip,
    userAgent,
    ...target
  }: BulkSetGamesActiveInput & CatalogActor) {
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);
    const bulkOperationId = randomUUID();

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);
      const { games, providerRows, notFoundGameIds, notFoundProviderIds } =
        await this.resolveGameScope(tx, gameIds, providerIds, 'update');
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

      const toFlip = games.filter((row) => row.isActive !== isActive).map((row) => row.id);
      let changedGameIds: string[] = [];
      if (toFlip.length > 0) {
        const rows = await tx
          .update(game)
          .set({ isActive })
          .where(inArray(game.id, toFlip))
          .returning({ id: game.id });
        changedGameIds = rows.map((row) => row.id);
      }

      const unplayableGameIds = isActive
        ? sortIds(
            (
              await tx
                .select({ id: game.id })
                .from(game)
                .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
                .where(and(condition, eq(game.isActive, true), eq(gameProvider.isActive, false)))
            ).map((row) => row.id),
          )
        : [];

      return {
        gameIds,
        providerIds,
        notFoundGameIds,
        notFoundProviderIds,
        changedGameIds: sortIds(changedGameIds),
        changedProviderIds: sortIds(changedProviderIds),
        changedProviderSnapshots,
        gamesUpdatedCount: changedGameIds.length,
        gamesUnchangedCount: games.length - changedGameIds.length,
        providersUpdatedCount: changedProviderIds.length,
        providersUnchangedCount: existingProviderIds.length - changedProviderIds.length,
        unplayableGameIds,
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
    };
  }

  async bulkAddGameTags({
    tagIds: rawTagIds,
    actorId,
    ip,
    userAgent,
    ...target
  }: BulkAddGameTagsInput & CatalogActor) {
    const tagIds = sortIds(dedupe(rawTagIds));
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);

      // The link insert's foreign-key check takes FOR KEY SHARE on each game row anyway;
      // taking it up front, in id order and before provider locks, avoids a deadlock.
      const { games, notFoundGameIds, notFoundProviderIds } = await this.resolveGameScope(
        tx,
        gameIds,
        providerIds,
        'key share',
      );

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
      let addedLinks: Array<{ gameId: string; tagIds: string[] }> = [];
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

  async bulkAddGameCategories({
    categoryIds: rawCategoryIds,
    actorId,
    ip,
    userAgent,
    ...target
  }: BulkAddGameCategoriesInput & CatalogActor) {
    const categoryIds = sortIds(dedupe(rawCategoryIds));
    const gameIds = sortIds(dedupe(target.gameIds));
    const providerIds = sortIds(dedupe(target.providerIds));
    const condition = targetCondition(gameIds, providerIds);

    const outcome = await this.drizzle.db.transaction(async (tx) => {
      await this.assertWithinGameCap(tx, condition);

      // The link insert's foreign-key check takes FOR KEY SHARE on each game row anyway;
      // taking it up front, in id order and before provider locks, avoids a deadlock.
      const { games, notFoundGameIds, notFoundProviderIds } = await this.resolveGameScope(
        tx,
        gameIds,
        providerIds,
        'key share',
      );

      const foundCategories = await tx
        .select({ id: gameCategory.id })
        .from(gameCategory)
        .where(inArray(gameCategory.id, categoryIds))
        .for('key share');
      const foundCategoryIds = new Set(foundCategories.map((row) => row.id));
      const missingCategoryId = categoryIds.find((id) => !foundCategoryIds.has(id));
      if (missingCategoryId) {
        throw new GameCategoryNotFoundError(missingCategoryId);
      }

      const matchedGameIds = games.map((row) => row.id);
      let addedLinks: Array<{ gameId: string; categoryIds: string[] }> = [];
      if (matchedGameIds.length > 0) {
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
