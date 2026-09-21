import { eq, sql } from 'drizzle-orm';
import { createLogger, DrizzleService } from '@openora/core/server';
import { GameSortService } from './game-sort.service.js';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  type GameCategory,
} from '../schema/index.js';
import { isGamePlayable, rankDirtyPatch } from '../../shared/game-catalog.js';

const logger = createLogger('gaming');

/**
 * Merges `pins` (gameId -> 0-based slot) into `order`: each pinned game claims its
 * slot, a slot past the end clamps to the tail (several such overflowing pins stack
 * there in ascending slot order), and a pin whose game isn't in `order` is ignored.
 */
export function mergePinnedOrder(
  order: readonly string[],
  pins: ReadonlyMap<string, number>,
): string[] {
  const rest = order.filter((id) => !pins.has(id));
  const pinned = order
    .filter((id) => pins.has(id))
    .sort((a, b) => (pins.get(a) ?? 0) - (pins.get(b) ?? 0));
  const result = [...rest];
  for (const id of pinned) {
    result.splice(Math.min(pins.get(id) ?? 0, result.length), 0, id);
  }
  return result;
}

type RankClaim = Pick<GameCategory, 'rankSeq' | 'sortKey' | 'sortDirection' | 'sortParams'>;

const MAX_RANK_ATTEMPTS = 3;

/**
 * Materializes a complete permutation with playable pins. Every attempt claims a
 * sequence; stale attempts retry from fresh input, failures preserve the last success.
 */
export class GameSortRankingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sorts: GameSortService,
  ) {}

  async rank(categoryId: GameCategory['id']): Promise<void> {
    for (let attempt = 0; attempt < MAX_RANK_ATTEMPTS; attempt += 1) {
      const claim = await this.claim(categoryId);
      if (!claim) {
        return;
      }
      let orderedIds: string[] | null;
      try {
        orderedIds = await this.compute(categoryId, claim);
      } catch (err) {
        logger.warn(
          { err, categoryId, sortKey: claim.sortKey },
          'gaming.category.rank: sort failed, retaining previous ranks',
        );
        orderedIds = null;
      }
      const outcome = await this.finalize(categoryId, claim, orderedIds);
      if (outcome !== 'stale') {
        return;
      }
    }
  }

  private async claim(categoryId: GameCategory['id']) {
    const [claim] = await this.drizzle.db
      .update(gameCategory)
      .set({ ...rankDirtyPatch(), updatedAt: sql`${gameCategory.updatedAt}` })
      .where(eq(gameCategory.id, categoryId))
      .returning({
        rankSeq: gameCategory.rankSeq,
        sortKey: gameCategory.sortKey,
        sortDirection: gameCategory.sortDirection,
        sortParams: gameCategory.sortParams,
      });
    return claim;
  }

  private async compute(categoryId: GameCategory['id'], claim: RankClaim) {
    const definition = this.sorts.requireDefinition(claim.sortKey);
    const params = definition.paramsSchema.parse(claim.sortParams ?? {});
    const direction = claim.sortDirection ?? definition.directions[0];
    if (!definition.directions.includes(direction)) {
      throw new Error('Configured sort direction is no longer supported');
    }
    const memberRows = await this.drizzle.db
      .select({
        gameId: gameCategoryGame.gameId,
        pinnedPosition: gameCategoryGame.pinnedPosition,
        isActive: game.isActive,
        isUnavailable: game.isUnavailable,
        providerIsActive: gameProvider.isActive,
      })
      .from(gameCategoryGame)
      .innerJoin(game, eq(gameCategoryGame.gameId, game.id))
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .where(eq(gameCategoryGame.categoryId, categoryId));
    const gameIds = memberRows.map((row) => row.gameId);

    const ranked = await definition.rank({ categoryId, gameIds, direction, params });

    // The definition's own order, sanitized to the category's actual members - a member
    // it omitted (or duplicated) still gets a rank, appended after in original member
    // order, rather than the old null "unranked" bucket.
    const memberIdSet = new Set(gameIds);
    const seen = new Set<string>();
    const definedOrder: string[] = [];
    for (const id of ranked) {
      if (memberIdSet.has(id) && !seen.has(id)) {
        seen.add(id);
        definedOrder.push(id);
      }
    }
    const omittedOrder = gameIds.filter((id) => !seen.has(id));
    const fullOrder = [...definedOrder, ...omittedOrder];

    // Pinning is relative to what a player can see - see the class docstring. A pin on a
    // currently-unplayable member sits unused in the DB until the game (or its provider)
    // becomes playable again and a re-rank picks it back up (the dirty-marking triggers
    // in shared/game-catalog.ts cover every path that can flip playability).
    const playableIds = new Set(
      memberRows
        .filter((row) =>
          isGamePlayable(
            { isActive: row.isActive, isUnavailable: row.isUnavailable },
            { isActive: row.providerIsActive },
          ),
        )
        .map((row) => row.gameId),
    );
    const playableOrder = fullOrder.filter((id) => playableIds.has(id));
    const unplayableOrder = fullOrder.filter((id) => !playableIds.has(id));
    const pins = new Map<string, number>();
    for (const row of memberRows) {
      if (row.pinnedPosition !== null && playableIds.has(row.gameId)) {
        pins.set(row.gameId, row.pinnedPosition);
      }
    }
    return [...mergePinnedOrder(playableOrder, pins), ...unplayableOrder];
  }

  private async finalize(
    categoryId: GameCategory['id'],
    claim: RankClaim,
    orderedIds: string[] | null,
  ) {
    return this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ rankSeq: gameCategory.rankSeq })
        .from(gameCategory)
        .where(eq(gameCategory.id, categoryId))
        .limit(1)
        .for('update');
      if (!locked) {
        return 'missing';
      }
      if (locked.rankSeq !== claim.rankSeq) {
        return 'stale';
      }
      if (orderedIds === null) {
        return 'failed';
      }
      if (orderedIds.length > 0) {
        await tx.execute(sql`
          UPDATE game_category_game AS gcg
          SET rank = (v.rnk - 1)::int
          FROM unnest(${sql.param(orderedIds)}::uuid[]) WITH ORDINALITY AS v(game_id, rnk)
          WHERE gcg.category_id = ${categoryId} AND gcg.game_id = v.game_id
            AND gcg.rank IS DISTINCT FROM (v.rnk - 1)::int
        `);
      }
      await tx
        .update(gameCategory)
        .set({
          rankedAt: sql`${gameCategory.rankDirtyAt}`,
          updatedAt: sql`${gameCategory.updatedAt}`,
        })
        .where(eq(gameCategory.id, categoryId));
      return 'success';
    });
  }
}
