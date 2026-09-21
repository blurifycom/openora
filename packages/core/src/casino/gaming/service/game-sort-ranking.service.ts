import { asc, eq, sql } from 'drizzle-orm';
import { createLogger, DrizzleService } from '@openora/core/server';
import type { GameSortCatalog, JobQueueAdapter } from '@openora/core/contracts';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  type GameCategory,
} from '../schema/index.js';
import { GAME_CATEGORY_RANK_QUEUE, RANK_SWEEP_BATCH_LIMIT } from '../contract/index.js';
import { isGamePlayable } from '../../shared/game-catalog.js';

const logger = createLogger('gaming');

// No idempotencyKey: BullMQ retains a completed jobId, so a categoryId-derived key would dedupe every later rank trigger.
export function enqueueGameCategoryRank(
  jobQueue: JobQueueAdapter,
  categoryId: GameCategory['id'],
): void {
  jobQueue.enqueue(GAME_CATEGORY_RANK_QUEUE, { categoryId }).catch((err: unknown) => {
    logger.error({ err, categoryId }, 'gaming.category.rank enqueue failed');
  });
}

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

type RankClaim = {
  rankSeq: number;
  startedAt: Date;
  dirtyAtAtClaim: Date | null;
};

// Two possibly-null timestamps read at different moments represent "nothing changed"
// only when they are the exact same instant (or both null) - a numeric `<`/`>` compare
// would be fooled by `now()` resolving to a writer's transaction-start time rather than
// its commit time (docs/modules/gaming.md).
function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.getTime() === b.getTime();
}

type RankResult = { orderedIds: string[] };

/**
 * Materializes a category's `rank` column from its configured sort. Never computes order
 * at request time (docs/modules/gaming.md) - this is the only writer of `rank`.
 *
 * An unknown sort key, params the definition rejects, or a throwing `rank()` all leave the
 * previous ranks untouched: this mirrors LobbyService's handling of an unknown/failing
 * lobby section (log a warning, skip) rather than retrying a failure no retry can fix. A
 * bailed run still advances `rankedAt` (via `finalize`) so a sweep does not retry the same
 * failure forever - only a genuinely new change (a fresh `rankDirtyAt`) triggers a retry.
 *
 * Pinning is a core-side concern the definition never sees (docs/modules/gaming.md): once
 * a definition's own order is sanitized down to the category's actual members, every
 * playable member is split out (playableGameCondition, single owner with the read
 * path), pins are merged into slots within that playable list only, and the unplayable
 * members are appended after in the definition's order - so a pin's slot is always
 * relative to what a player can actually see, and every member ends up with an explicit
 * rank (never the old "omitted" null bucket).
 */
export class GameSortRankingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sortCatalog: GameSortCatalog,
    private readonly jobQueue: JobQueueAdapter,
  ) {}

  async rank(categoryId: GameCategory['id']): Promise<void> {
    // Claims a fencing token (rankSeq) and reads config + a DB-clock start time in one
    // statement - see docs/modules/gaming.md for why this run-vs-run guard is a separate
    // concern from the row lock that serializes an admin's own writes.
    // `now()` comes back as the raw driver string, not a Date - it is a plain `sql`
    // expression, not a column with drizzle's own timestamp read-mapping - so it is
    // parsed explicitly below before it is ever written back to a timestamp column.
    const [rawClaim] = await this.drizzle.db
      .update(gameCategory)
      .set({
        rankSeq: sql`${gameCategory.rankSeq} + 1`,
        updatedAt: sql`${gameCategory.updatedAt}`,
      })
      .where(eq(gameCategory.id, categoryId))
      .returning({
        rankSeq: gameCategory.rankSeq,
        sortKey: gameCategory.sortKey,
        sortDirection: gameCategory.sortDirection,
        sortParams: gameCategory.sortParams,
        // Read in the same statement as the claim so finalize() can detect whether a
        // concurrent write touched it while this run was in flight - see sameInstant().
        dirtyAtAtClaim: gameCategory.rankDirtyAt,
        startedAt: sql<string>`now()`,
      });
    if (!rawClaim) {
      logger.warn({ categoryId }, 'gaming.category.rank: category no longer exists, skipping');
      return;
    }
    const claim = { ...rawClaim, startedAt: new Date(rawClaim.startedAt) };

    const definition = this.sortCatalog.get(claim.sortKey);
    if (!definition) {
      logger.warn(
        { categoryId, sortKey: claim.sortKey },
        'gaming.category.rank: unknown sort key, leaving ranks untouched',
      );
      return this.finalize(categoryId, claim, null);
    }

    const parsedParams = definition.paramsSchema.safeParse(claim.sortParams ?? {});
    if (!parsedParams.success) {
      logger.warn(
        { categoryId, sortKey: claim.sortKey, issues: parsedParams.error.issues },
        'gaming.category.rank: invalid sort params, leaving ranks untouched',
      );
      return this.finalize(categoryId, claim, null);
    }

    const direction = claim.sortDirection ?? definition.directions[0];
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

    let ranked: string[];
    try {
      ranked = await definition.rank({
        categoryId,
        gameIds,
        direction,
        params: parsedParams.data,
      });
    } catch (err) {
      logger.warn(
        { err, categoryId, sortKey: claim.sortKey },
        'gaming.category.rank: sort definition threw, leaving ranks untouched',
      );
      return this.finalize(categoryId, claim, null);
    }

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
    const orderedIds = [...mergePinnedOrder(playableOrder, pins), ...unplayableOrder];

    await this.finalize(categoryId, claim, { orderedIds });
  }

  /**
   * Fenced write: discards the run unless `claim.rankSeq` is still the most recently
   * claimed value. A bailed run (`ranks === null`) always advances `rankedAt` to
   * `claim.startedAt` regardless of `rankDirtyAt`, so a broken sort definition doesn't
   * loop hot on every sweep pass. A successful run only advances `rankedAt` when
   * `rankDirtyAt` (re-read here, under the same lock, via `sameInstant`) is unchanged
   * since the claim - `now()` is Postgres transaction-start time, so a writer whose
   * transaction began before this claim but commits mid-run can stamp a `rankDirtyAt`
   * that is numerically *earlier* than `claim.startedAt` even though its write landed
   * after we read our data; comparing values instead of timestamps catches that write
   * regardless of where its clock reads. When it changed, `rankedAt` is left as-is so
   * the category stays dirty for the next sweep pass - no work is ever lost. See
   * docs/modules/gaming.md.
   */
  private async finalize(
    categoryId: GameCategory['id'],
    claim: RankClaim,
    ranks: RankResult | null,
  ): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ rankSeq: gameCategory.rankSeq, rankDirtyAt: gameCategory.rankDirtyAt })
        .from(gameCategory)
        .where(eq(gameCategory.id, categoryId))
        .limit(1)
        .for('update');
      if (!locked || locked.rankSeq !== claim.rankSeq) {
        return;
      }
      if (ranks && ranks.orderedIds.length > 0) {
        // A successful run always covers every member (see rank() above), so this is a
        // complete permutation - no separate "leave the rest null" branch is needed.
        // The IS DISTINCT FROM guard skips a row whose rank didn't actually move - an
        // idempotent repeat run (the common case) then rewrites nothing.
        await tx.execute(sql`
          UPDATE game_category_game AS gcg
          SET rank = (v.rnk - 1)::int
          FROM unnest(${sql.param(ranks.orderedIds)}::uuid[]) WITH ORDINALITY AS v(game_id, rnk)
          WHERE gcg.category_id = ${categoryId} AND gcg.game_id = v.game_id
            AND gcg.rank IS DISTINCT FROM (v.rnk - 1)::int
        `);
      }
      if (ranks === null || sameInstant(locked.rankDirtyAt, claim.dirtyAtAtClaim)) {
        await tx
          .update(gameCategory)
          .set({ rankedAt: claim.startedAt, updatedAt: sql`${gameCategory.updatedAt}` })
          .where(eq(gameCategory.id, categoryId));
      }
    });
  }

  /**
   * Durable backstop for a lost post-commit enqueue: enqueues a rank run for every
   * category whose last change (`rankDirtyAt`) is newer than its last completed run
   * (`rankedAt`), oldest-dirty-first and capped at `RANK_SWEEP_BATCH_LIMIT` per pass so a
   * large backlog drains gradually instead of compounding every interval - see
   * docs/modules/gaming.md. Idempotent by construction - re-enqueuing an already-current
   * category is a harmless no-op once `rank()` re-reads its now-current state.
   */
  async sweep(): Promise<void> {
    const dirty = await this.drizzle.db
      .select({ id: gameCategory.id })
      .from(gameCategory)
      .where(
        sql`${gameCategory.rankDirtyAt} IS NOT NULL AND (${gameCategory.rankedAt} IS NULL OR ${gameCategory.rankedAt} < ${gameCategory.rankDirtyAt})`,
      )
      .orderBy(asc(gameCategory.rankDirtyAt))
      .limit(RANK_SWEEP_BATCH_LIMIT);
    for (const { id } of dirty) {
      enqueueGameCategoryRank(this.jobQueue, id);
    }
  }
}
