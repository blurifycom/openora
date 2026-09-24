import { and, asc, sql } from 'drizzle-orm';
import { createLogger, type DrizzleService } from '@openora/core/server';
import { domainEventSchemas, type JobQueueAdapter } from '@openora/core/contracts';
import { gameCategory, type GameCategory } from '../schema/index.js';
import {
  GAME_CATEGORY_RANK_QUEUE,
  GAME_CATEGORY_RANK_SWEEP_QUEUE,
  RANK_RETRY_BASE_MS,
  RANK_RETRY_MAX_MS,
  RANK_SWEEP_BATCH_LIMIT,
  RANK_SWEEP_INTERVAL_MS,
} from '../contract/index.js';
import {
  categoryIdsForGameIds,
  categoryIdsForProviderIds,
  categoryRankTriggerIds,
  isRankDirty,
} from '../../shared/game-catalog.js';

const logger = createLogger('gaming');

// A claim stamps rankDirtyAt, so for a failed category it is the time of its last attempt.
// The exponent is capped so power() cannot overflow on a long failure streak.
function retryDue() {
  return sql`(${gameCategory.rankFailures} = 0 OR ${gameCategory.rankDirtyAt} <= now() - make_interval(secs => least(${RANK_RETRY_BASE_MS / 1000}::float8 * power(2, least(${gameCategory.rankFailures} - 1, 30)), ${RANK_RETRY_MAX_MS / 1000}::float8)))`;
}

// BullMQ retains completed job IDs, so category IDs cannot serve as enqueue idempotency keys.
export function enqueueGameCategoryRank(
  jobQueue: JobQueueAdapter,
  categoryId: GameCategory['id'],
): void {
  void jobQueue.enqueue(GAME_CATEGORY_RANK_QUEUE, { categoryId }).catch((err: unknown) => {
    logger.error({ err, categoryId }, 'gaming.category.rank enqueue failed');
  });
}

export class GameSortTriggerService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly jobQueue: JobQueueAdapter,
  ) {}

  private enqueueCategories(categoryIds: readonly GameCategory['id'][]) {
    for (const categoryId of new Set(categoryIds)) {
      enqueueGameCategoryRank(this.jobQueue, categoryId);
    }
  }

  private enqueueLookup(lookup: Promise<GameCategory['id'][]>) {
    void lookup
      .then((categoryIds) => this.enqueueCategories(categoryIds))
      .catch((err: unknown) => {
        logger.error({ err }, 'gaming.category.rank trigger lookup failed');
      });
  }

  gameUpdated(payload: unknown) {
    const parsed = domainEventSchemas['gaming.game.updated'].safeParse(payload);
    if (parsed.success) {
      this.enqueueCategories(categoryRankTriggerIds(parsed.data.before, parsed.data.after));
    }
  }

  gamesBulkUpdated(payload: unknown) {
    const parsed = domainEventSchemas['gaming.games.bulk_updated'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    if (parsed.data.operation === 'add_categories') {
      this.enqueueCategories(parsed.data.categoryIds);
      return;
    }
    if (parsed.data.operation !== 'set_active') {
      return;
    }
    if (parsed.data.affectedCategoryIds !== undefined) {
      this.enqueueCategories(parsed.data.affectedCategoryIds);
      return;
    }
    this.enqueueLookup(
      Promise.all([
        categoryIdsForGameIds(this.drizzle.db, parsed.data.changedGameIds),
        categoryIdsForProviderIds(this.drizzle.db, parsed.data.changedProviderIds),
      ]).then(([byGame, byProvider]) => [...byGame, ...byProvider]),
    );
  }

  providerUpdated(payload: unknown) {
    const parsed = domainEventSchemas['gaming.provider.updated'].safeParse(payload);
    if (parsed.success && parsed.data.before.isActive !== parsed.data.after.isActive) {
      this.enqueueLookup(categoryIdsForProviderIds(this.drizzle.db, [parsed.data.providerId]));
    }
  }

  gameAvailabilityChanged(payload: unknown) {
    const parsed = domainEventSchemas['gaming.game.availability_changed'].safeParse(payload);
    if (parsed.success && parsed.data.before.isUnavailable !== parsed.data.after.isUnavailable) {
      this.enqueueLookup(categoryIdsForGameIds(this.drizzle.db, [parsed.data.gameId]));
    }
  }

  scheduleSweep() {
    void this.jobQueue
      .schedule(
        GAME_CATEGORY_RANK_SWEEP_QUEUE,
        'gaming-category-rank-sweep',
        {},
        {
          everyMs: RANK_SWEEP_INTERVAL_MS,
        },
      )
      .catch((err: unknown) => {
        logger.error({ err }, 'gaming.category.rank-sweep schedule failed');
      });
  }

  async sweep() {
    const dirty = await this.drizzle.db
      .select({ id: gameCategory.id })
      .from(gameCategory)
      .where(and(isRankDirty(), retryDue()))
      .orderBy(asc(gameCategory.rankDirtyAt), asc(gameCategory.id))
      .limit(RANK_SWEEP_BATCH_LIMIT);
    this.enqueueCategories(dirty.map(({ id }) => id));
  }
}
