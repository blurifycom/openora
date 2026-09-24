import * as z from 'zod';
import { asc, desc, inArray } from 'drizzle-orm';
import { defineGameSort, type GameSortDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { game } from '../../schema/index.js';

const NameSortParamsSchema = z.object({});

/** Alphabetical by game name, either direction, tie-broken by id for a stable order. */
export function createNameGameSort(
  drizzle: DrizzleService,
): GameSortDefinition<z.infer<typeof NameSortParamsSchema>> {
  return defineGameSort({
    key: 'name',
    directions: ['asc', 'desc'],
    paramsSchema: NameSortParamsSchema,
    async rank({ gameIds, direction }) {
      if (gameIds.length === 0) {
        return [];
      }
      const rows = await drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(inArray(game.id, gameIds))
        .orderBy(direction === 'desc' ? desc(game.name) : asc(game.name), asc(game.id));
      return rows.map((row) => row.id);
    },
  });
}
