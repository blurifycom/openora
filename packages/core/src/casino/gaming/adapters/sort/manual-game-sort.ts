import * as z from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { defineGameSort, type GameSortDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { game, gameCategoryGame } from '../../schema/index.js';

const ManualSortParamsSchema = z.object({});

/**
 * Drag-and-drop order: the operator's own `position` on the category-game link, games
 * without one sorting last by name. `position` is set only by the reorder route, never by
 * this definition - `rank()` just reads what is already there.
 */
export function createManualGameSort(
  drizzle: DrizzleService,
): GameSortDefinition<z.infer<typeof ManualSortParamsSchema>> {
  return defineGameSort({
    key: 'manual',
    directions: ['asc'],
    paramsSchema: ManualSortParamsSchema,
    async rank({ categoryId, gameIds }) {
      if (gameIds.length === 0) {
        return [];
      }
      const rows = await drizzle.db
        .select({ id: game.id })
        .from(gameCategoryGame)
        .innerJoin(game, eq(gameCategoryGame.gameId, game.id))
        .where(
          and(
            eq(gameCategoryGame.categoryId, categoryId),
            inArray(gameCategoryGame.gameId, gameIds),
          ),
        )
        .orderBy(
          sql`${gameCategoryGame.position} IS NULL`,
          asc(gameCategoryGame.position),
          asc(game.name),
          asc(game.id),
        );
      return rows.map((row) => row.id);
    },
  });
}
