import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@openora/core/server';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  type Game,
  type GameCategory,
  type GameProvider,
} from '@openora/core/casino/schema/gaming';

// A game is player-visible only when the game itself and its provider are both
// active. Single owner for the "enabled" definition - the public list/search
// filters and the startRound gate must never drift apart.
export function playableGameCondition() {
  return and(eq(game.isActive, true), eq(gameProvider.isActive, true));
}

export function isGamePlayable(
  target: Pick<Game, 'isActive'>,
  provider: Pick<GameProvider, 'isActive'>,
): boolean {
  return target.isActive === true && provider.isActive === true;
}

// One batched query for many games - never per-game lookups (no N+1).
// Shared by gaming and lobby so the join + ordering has a single owner.
export async function categoriesByGameIds(db: DrizzleDb, gameIds: Game['id'][]) {
  if (gameIds.length === 0) {
    return new Map<Game['id'], GameCategory[]>();
  }
  const rows = await db
    .select({ gameId: gameCategoryGame.gameId, category: gameCategory })
    .from(gameCategoryGame)
    .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
    .where(inArray(gameCategoryGame.gameId, gameIds))
    .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name));
  const map = new Map<Game['id'], GameCategory[]>();
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
