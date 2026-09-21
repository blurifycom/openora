import { GameSortService } from '../service/game-sort.service.js';
import { GameSortTriggerService } from '../service/game-sort-trigger.service.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { createGameSortCatalog, defineGameSort } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { GameSortRankingService } from '../service/game-sort-ranking.service.js';
import { markCategoriesRankDirty } from '../../shared/game-catalog.js';
import { makeJobQueue } from '../../../testing/mock.js';

const EmptyParamsSchema = z.object({});

let db: TestDb;

async function seedProvider() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true })
      .returning(),
    new Error('seedProvider: query returned no row'),
  );
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `category-${randomUUID()}`, name: 'Category', ...overrides })
      .returning(),
    new Error('seedCategory: query returned no row'),
  );
}

async function seedGame(
  providerId: string,
  overrides: Partial<typeof game.$inferInsert> = {},
  categoryIds: string[] = [],
) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'direct',
        isActive: true,
        ...overrides,
      })
      .returning(),
    new Error('seedGame: query returned no row'),
  );
  if (categoryIds.length > 0) {
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values(categoryIds.map((categoryId) => ({ gameId: row.id, categoryId })));
  }
  return row;
}

async function ranksFor(categoryId: string) {
  const rows = await db.drizzle.db
    .select({ gameId: gameCategoryGame.gameId, rank: gameCategoryGame.rank })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.categoryId, categoryId))
    .orderBy(asc(gameCategoryGame.gameId));
  return rows;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameCategoryGame}, ${game}, ${gameCategory}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

async function categoryRow(categoryId: string) {
  return findOneOrThrow(
    await db.drizzle.db.select().from(gameCategory).where(eq(gameCategory.id, categoryId)),
    new Error('categoryRow: query returned no row'),
  );
}

async function markDirty(categoryId: string) {
  await db.drizzle.db.transaction((tx) => markCategoriesRankDirty(tx, [categoryId]));
}

function makeRankingService(jobQueue = makeJobQueue()) {
  const catalog = createGameSortCatalog(createDefaultGameSorts(db.drizzle));
  return { svc: new GameSortRankingService(db.drizzle, new GameSortService(catalog)), jobQueue };
}

describe('GameSortRankingService (real PG)', () => {
  it('materializes name-sort ranks, is idempotent on a repeat run, and never bumps updatedAt', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'name' });
    const b = await seedGame(provider.id, { name: 'B Game' }, [category.id]);
    const a = await seedGame(provider.id, { name: 'A Game' }, [category.id]);
    const updatedAtBefore = (await categoryRow(category.id)).updatedAt;

    const { svc } = makeRankingService();
    await svc.rank(category.id);
    const firstRun = await ranksFor(category.id);
    expect(firstRun.find((r) => r.gameId === a.id)?.rank).toBe(0);
    expect(firstRun.find((r) => r.gameId === b.id)?.rank).toBe(1);

    await svc.rank(category.id);
    const secondRun = await ranksFor(category.id);
    expect(secondRun).toEqual(firstRun);

    const updatedAtAfter = (await categoryRow(category.id)).updatedAt;
    expect(updatedAtAfter.getTime()).toBe(updatedAtBefore.getTime());
  });

  it('keeps independent order for a game shared by two categories', async () => {
    const provider = await seedProvider();
    const catA = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
    const catB = await seedCategory({ sortKey: 'name', sortDirection: 'desc' });
    const shared = await seedGame(provider.id, { name: 'M Game' }, [catA.id, catB.id]);
    const other = await seedGame(provider.id, { name: 'Z Game' }, [catA.id, catB.id]);

    const { svc } = makeRankingService();
    await svc.rank(catA.id);
    await svc.rank(catB.id);

    const [ascRank] = await db.drizzle.db
      .select({ rank: gameCategoryGame.rank })
      .from(gameCategoryGame)
      .where(
        sql`${gameCategoryGame.categoryId} = ${catA.id} AND ${gameCategoryGame.gameId} = ${shared.id}`,
      );
    const [descRank] = await db.drizzle.db
      .select({ rank: gameCategoryGame.rank })
      .from(gameCategoryGame)
      .where(
        sql`${gameCategoryGame.categoryId} = ${catB.id} AND ${gameCategoryGame.gameId} = ${shared.id}`,
      );
    expect(ascRank?.rank).toBe(0);
    expect(descRank?.rank).toBe(1);
    expect(other).toBeTruthy();
  });

  it('leaves previous ranks untouched when the configured sort key is unknown', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'name' });
    const g1 = await seedGame(provider.id, { name: 'A' }, [category.id]);
    const { svc } = makeRankingService();
    await svc.rank(category.id);
    const before = await ranksFor(category.id);
    expect(before.find((r) => r.gameId === g1.id)?.rank).toBe(0);

    await db.drizzle.db
      .update(gameCategory)
      .set({ sortKey: 'since-removed-sort' })
      .where(eq(gameCategory.id, category.id));

    await expect(svc.rank(category.id)).resolves.toBeUndefined();
    expect(await ranksFor(category.id)).toEqual(before);
  });

  it('leaves previous ranks untouched when the sort definition throws', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'throwing' });
    const g1 = await seedGame(provider.id, { name: 'A' }, [category.id]);

    const throwing = defineGameSort({
      key: 'throwing',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank() {
        throw new Error('boom');
      },
    });
    const catalog = createGameSortCatalog([throwing]);
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

    await expect(svc.rank(category.id)).resolves.toBeUndefined();
    const rows = await ranksFor(category.id);
    expect(rows.find((r) => r.gameId === g1.id)?.rank).toBeNull();
  });

  it('a run invalidated by a newer completed run recomputes before writing', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'racing' });
    const first = await seedGame(provider.id, { name: 'First' }, [category.id]);
    const second = await seedGame(provider.id, { name: 'Second' }, [category.id]);

    let callCount = 0;
    let releaseFirstCall: () => void = () => {};
    const firstCallBlocked = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    let firstCallReached: () => void = () => {};
    const firstCallReachedPromise = new Promise<void>((resolve) => {
      firstCallReached = resolve;
    });

    const racing = defineGameSort({
      key: 'racing',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        callCount += 1;
        if (callCount === 1) {
          firstCallReached();
          await firstCallBlocked;
          return [...gameIds];
        }
        return [...gameIds].reverse();
      },
    });
    const catalog = createGameSortCatalog([racing]);
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

    const runA = svc.rank(category.id);
    await firstCallReachedPromise;
    const runB = svc.rank(category.id);
    await runB;
    releaseFirstCall();
    await runA;

    expect(callCount).toBe(3);
    const rows = await ranksFor(category.id);
    expect(rows.find((r) => r.gameId === second.id)?.rank).toBe(0);
    expect(rows.find((r) => r.gameId === first.id)?.rank).toBe(1);
  });

  it('a change landing mid-run discards its result and retries from current inputs', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'racing2' });
    await seedGame(provider.id, { name: 'A' }, [category.id]);

    let releaseRun: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    let firstRun = true;
    const racing = defineGameSort({
      key: 'racing2',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        if (firstRun) {
          firstRun = false;
          await markDirty(category.id);
          await blocked;
        }
        return gameIds;
      },
    });
    const catalog = createGameSortCatalog([racing]);
    const jobQueue = makeJobQueue();
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

    const runPromise = svc.rank(category.id);
    await vi.waitFor(async () => {
      const row = await categoryRow(category.id);
      expect(row.rankDirtyAt).not.toBeNull();
    });
    releaseRun();
    await runPromise;

    const row = await categoryRow(category.id);
    expect(row.rankedAt).not.toBeNull();
    expect(row.rankDirtyAt).not.toBeNull();
    expect(row.rankSeq).toBe(3);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it('retries an input change committed by a transaction that began before the claim', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'midrun_case1' });
    await seedGame(provider.id, { name: 'A' }, [category.id]);

    let unblockWriter: () => void = () => {};
    const writerCanProceed = new Promise<void>((resolve) => {
      unblockWriter = resolve;
    });
    let writerBegun: () => void = () => {};
    const writerHasBegun = new Promise<void>((resolve) => {
      writerBegun = resolve;
    });
    const writerTx = db.drizzle.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      writerBegun();
      await writerCanProceed;
      await markCategoriesRankDirty(tx, [category.id]);
    });
    await writerHasBegun;

    const midRun = defineGameSort({
      key: 'midrun_case1',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        unblockWriter();
        await writerTx;
        return gameIds;
      },
    });
    const catalog = createGameSortCatalog([midRun]);
    const jobQueue = makeJobQueue();
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

    await svc.rank(category.id);

    const row = await categoryRow(category.id);
    expect(row.rankedAt).not.toBeNull();
    expect(row.rankSeq).toBe(3);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it('recovers via sweep when the fast-path enqueue is lost, converging to current config', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'name' });
    const b = await seedGame(provider.id, { name: 'B Game' }, [category.id]);
    const a = await seedGame(provider.id, { name: 'A Game' }, [category.id]);

    await markDirty(category.id);

    const { svc, jobQueue } = makeRankingService();
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).toHaveBeenCalledWith(expect.anything(), { categoryId: category.id });

    await svc.rank(category.id);
    const rows = await ranksFor(category.id);
    expect(rows.find((r) => r.gameId === a.id)?.rank).toBe(0);
    expect(rows.find((r) => r.gameId === b.id)?.rank).toBe(1);

    jobQueue.enqueue.mockClear();
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it('leaves a failed explicit run dirty for the periodic sweep without stamping success', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'throwing2' });
    await seedGame(provider.id, { name: 'A' }, [category.id]);
    const successAt = new Date('2026-01-01T00:00:00Z');
    await db.drizzle.db
      .update(gameCategory)
      .set({ rankedAt: successAt })
      .where(eq(gameCategory.id, category.id));

    const throwing = defineGameSort({
      key: 'throwing2',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank() {
        throw new Error('boom');
      },
    });
    const catalog = createGameSortCatalog([throwing]);
    const jobQueue = makeJobQueue();
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

    await svc.rank(category.id);
    expect((await categoryRow(category.id)).rankedAt).toEqual(successAt);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).toHaveBeenCalledWith(expect.anything(), { categoryId: category.id });
  });

  it('never materializes stale results while waiting for a retry to compute', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'changing' });
    const first = await seedGame(provider.id, { name: 'First' }, [category.id]);
    const second = await seedGame(provider.id, { name: 'Second' }, [category.id]);
    let releaseRetry: () => void = () => {};
    const retryBlocked = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryReached: () => void = () => {};
    const retryStarted = new Promise<void>((resolve) => {
      retryReached = resolve;
    });
    let calls = 0;
    const changing = defineGameSort({
      key: 'changing',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank() {
        calls += 1;
        if (calls === 1) {
          await markDirty(category.id);
          return [first.id, second.id];
        }
        retryReached();
        await retryBlocked;
        return [second.id, first.id];
      },
    });
    const svc = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([changing])),
    );
    const run = svc.rank(category.id);
    await retryStarted;
    try {
      expect((await ranksFor(category.id)).every(({ rank }) => rank === null)).toBe(true);
    } finally {
      releaseRetry();
    }
    await run;
    expect((await ranksFor(category.id)).find(({ gameId }) => gameId === second.id)?.rank).toBe(0);
  });

  it('retries a stale failure instead of letting the old error suppress newer work', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'changing_failure' });
    const member = await seedGame(provider.id, {}, [category.id]);
    let calls = 0;
    const changing = defineGameSort({
      key: 'changing_failure',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        calls += 1;
        if (calls === 1) {
          await markDirty(category.id);
          throw new Error('old input failed');
        }
        return gameIds;
      },
    });
    const jobQueue = makeJobQueue();
    const svc = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([changing])),
    );
    await svc.rank(category.id);
    expect(calls).toBe(2);
    expect((await ranksFor(category.id)).find(({ gameId }) => gameId === member.id)?.rank).toBe(0);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it('bounds stale retries and preserves dirty work for a later sweep', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'contended' });
    await seedGame(provider.id, {}, [category.id]);
    let calls = 0;
    const contended = defineGameSort({
      key: 'contended',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        calls += 1;
        await markDirty(category.id);
        return gameIds;
      },
    });
    const jobQueue = makeJobQueue();
    const svc = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([contended])),
    );
    await svc.rank(category.id);
    expect(calls).toBe(3);
    expect((await categoryRow(category.id)).rankedAt).toBeNull();
    expect((await ranksFor(category.id)).every(({ rank }) => rank === null)).toBe(true);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).toHaveBeenCalledWith(expect.anything(), { categoryId: category.id });
  });

  it('invalidates a configuration roundtrip even when dirty timestamps are equal', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'roundtrip' });
    const first = await seedGame(provider.id, { name: 'First' }, [category.id]);
    const second = await seedGame(provider.id, { name: 'Second' }, [category.id]);
    let calls = 0;
    const roundtrip = defineGameSort({
      key: 'roundtrip',
      directions: ['asc', 'desc'],
      paramsSchema: EmptyParamsSchema,
      async rank() {
        calls += 1;
        if (calls === 1) {
          const claimed = await categoryRow(category.id);
          await db.drizzle.db.transaction(async (tx) => {
            await markCategoriesRankDirty(tx, [category.id]);
            await tx
              .update(gameCategory)
              .set({ sortDirection: 'desc' })
              .where(eq(gameCategory.id, category.id));
            await markCategoriesRankDirty(tx, [category.id]);
            await tx
              .update(gameCategory)
              .set({ sortDirection: null, rankDirtyAt: claimed.rankDirtyAt })
              .where(eq(gameCategory.id, category.id));
          });
          return [first.id, second.id];
        }
        return [second.id, first.id];
      },
    });
    const svc = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([roundtrip])),
    );
    await svc.rank(category.id);
    expect(calls).toBe(2);
    expect((await ranksFor(category.id)).find(({ gameId }) => gameId === second.id)?.rank).toBe(0);
  });

  it('moves an attempted failure behind older pending work in a capped sweep', async () => {
    const failed = await seedCategory({
      sortKey: 'missing',
      rankDirtyAt: new Date('2026-01-01T00:00:00Z'),
    });
    await db.drizzle.db.insert(gameCategory).values(
      Array.from({ length: 200 }, () => ({
        slug: `pending-${randomUUID()}`,
        name: 'Pending',
        rankDirtyAt: new Date('2026-01-02T00:00:00Z'),
      })),
    );
    const { svc, jobQueue } = makeRankingService();
    await svc.rank(failed.id);
    await new GameSortTriggerService(db.drizzle, jobQueue).sweep();
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(200);
    expect(jobQueue.enqueue).not.toHaveBeenCalledWith(expect.anything(), { categoryId: failed.id });
    expect((await categoryRow(failed.id)).rankedAt).toBeNull();
  });

  it('sorts a newly added, not-yet-ranked category member last by name', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'name' });
    const ranked = await seedGame(provider.id, { name: 'A Game' }, [category.id]);
    const { svc } = makeRankingService();
    await svc.rank(category.id);

    const late = await seedGame(provider.id, { name: 'Z Late Game' }, [category.id]);
    const rows = await ranksFor(category.id);
    expect(rows.find((r) => r.gameId === ranked.id)?.rank).toBe(0);
    expect(rows.find((r) => r.gameId === late.id)?.rank).toBeNull();
  });

  it('gives every member an explicit rank now, even one a definition omits entirely', async () => {
    const provider = await seedProvider();
    const category = await seedCategory({ sortKey: 'partial' });
    const kept = await seedGame(provider.id, { name: 'Kept' }, [category.id]);
    const omitted = await seedGame(provider.id, { name: 'Omitted' }, [category.id]);

    const partial = defineGameSort({
      key: 'partial',
      directions: ['asc'],
      paramsSchema: EmptyParamsSchema,
      async rank({ gameIds }) {
        return gameIds.filter((id) => id === kept.id);
      },
    });
    const catalog = createGameSortCatalog([partial]);
    const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));
    await svc.rank(category.id);

    const rows = await ranksFor(category.id);
    expect(rows.find((r) => r.gameId === kept.id)?.rank).toBe(0);
    expect(rows.find((r) => r.gameId === omitted.id)?.rank).toBe(1);
  });

  async function pinGame(categoryId: string, gameId: string, position: number) {
    await db.drizzle.db
      .update(gameCategoryGame)
      .set({ pinnedPosition: position })
      .where(
        sql`${gameCategoryGame.categoryId} = ${categoryId} AND ${gameCategoryGame.gameId} = ${gameId}`,
      );
  }

  async function orderFor(categoryId: string) {
    const rows = await db.drizzle.db
      .select({ gameId: gameCategoryGame.gameId, rank: gameCategoryGame.rank })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, categoryId));
    return rows
      .filter((row): row is { gameId: string; rank: number } => row.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => row.gameId);
  }

  describe('pinning', () => {
    it('holds a pinned game at its slot across a name-asc re-rank', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
      const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
      const charlie = await seedGame(provider.id, { name: 'Charlie' }, [category.id]);
      await pinGame(category.id, charlie.id, 0);

      const { svc } = makeRankingService();
      await svc.rank(category.id);

      expect(await orderFor(category.id)).toEqual([charlie.id, alpha.id, bravo.id]);
    });

    it('holds a pinned game at its slot across a name-desc re-rank', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'desc' });
      const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
      const charlie = await seedGame(provider.id, { name: 'Charlie' }, [category.id]);
      await pinGame(category.id, alpha.id, 1);

      const { svc } = makeRankingService();
      await svc.rank(category.id);

      expect(await orderFor(category.id)).toEqual([charlie.id, alpha.id, bravo.id]);
    });

    it('holds a pinned game at its slot under a custom definition', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'reverse_id' });
      const g1 = await seedGame(provider.id, { name: 'G1' }, [category.id]);
      const g2 = await seedGame(provider.id, { name: 'G2' }, [category.id]);
      const g3 = await seedGame(provider.id, { name: 'G3' }, [category.id]);
      await pinGame(category.id, g1.id, 0);

      const reverseId = defineGameSort({
        key: 'reverse_id',
        directions: ['asc'],
        paramsSchema: EmptyParamsSchema,
        async rank({ gameIds }) {
          return [...gameIds].sort().reverse();
        },
      });
      const catalog = createGameSortCatalog([reverseId]);
      const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));
      await svc.rank(category.id);

      const order = await orderFor(category.id);
      expect(order[0]).toBe(g1.id);
      expect(new Set(order.slice(1))).toEqual(new Set([g2.id, g3.id]));
    });

    it('survives a sort-mode change - still holds its slot under the new definition', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
      const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
      await pinGame(category.id, bravo.id, 0);

      const { svc, jobQueue } = makeRankingService();
      await svc.rank(category.id);
      expect(await orderFor(category.id)).toEqual([bravo.id, alpha.id]);

      await db.drizzle.db
        .update(gameCategory)
        .set({ sortKey: 'manual', sortDirection: null })
        .where(eq(gameCategory.id, category.id));
      const svc2 = makeRankingService(jobQueue).svc;
      await svc2.rank(category.id);
      expect(await orderFor(category.id)).toEqual([bravo.id, alpha.id]);
    });

    it("keeps a pin's slot relative to playable games only", async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
      const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(provider.id, { name: 'Bravo', isActive: false }, [category.id]);
      const charlie = await seedGame(provider.id, { name: 'Charlie' }, [category.id]);
      await pinGame(category.id, charlie.id, 0);

      const { svc } = makeRankingService();
      await svc.rank(category.id);

      expect(await orderFor(category.id)).toEqual([charlie.id, alpha.id, bravo.id]);
    });

    it('has no effect while its game is unplayable, and re-applies once it is playable again', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
      const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(provider.id, { name: 'Bravo', isActive: false }, [category.id]);
      await pinGame(category.id, bravo.id, 0);

      const { svc, jobQueue } = makeRankingService();
      await svc.rank(category.id);
      expect(await orderFor(category.id)).toEqual([alpha.id, bravo.id]);

      await db.drizzle.db.update(game).set({ isActive: true }).where(eq(game.id, bravo.id));
      const svc2 = makeRankingService(jobQueue).svc;
      await svc2.rank(category.id);
      expect(await orderFor(category.id)).toEqual([bravo.id, alpha.id]);
    });

    it('re-ranks correctly after a provider deactivation shrinks the playable count an overflowing pin clamps against', async () => {
      const providerA = await seedProvider();
      const providerB = await seedProvider();
      const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
      const alpha = await seedGame(providerA.id, { name: 'Alpha' }, [category.id]);
      const bravo = await seedGame(providerA.id, { name: 'Bravo' }, [category.id]);
      const charlie = await seedGame(providerB.id, { name: 'Charlie' }, [category.id]);
      await pinGame(category.id, alpha.id, 10);

      const { svc, jobQueue } = makeRankingService();
      await svc.rank(category.id);
      expect(await orderFor(category.id)).toEqual([bravo.id, charlie.id, alpha.id]);

      await db.drizzle.db
        .update(gameProvider)
        .set({ isActive: false })
        .where(eq(gameProvider.id, providerB.id));
      const svc2 = makeRankingService(jobQueue).svc;
      await svc2.rank(category.id);
      expect(await orderFor(category.id)).toEqual([bravo.id, alpha.id, charlie.id]);
    });
  });

  describe('lock order vs a category-membership writer', () => {
    // GamingService.updateGame and GameBulkService.addGameCategories both mark a
    // category's rankDirtyAt (locking game_category) before writing game_category_game,
    // the same order finalize() itself uses (game_category FOR UPDATE, then
    // game_category_game) - see docs/modules/gaming.md. Before that fix, a writer taking
    // the opposite order could deadlock with a concurrent finalize; Postgres resolves
    // that by aborting one side, which surfaced as an unmapped 500 on the admin PATCH.
    // Exercising this through GamingService.updateGame itself would need to pause its
    // transaction at a point its public API doesn't expose, so this drives the same
    // shared primitives (markCategoriesRankDirty, GameSortRankingService.finalize) both
    // call, under deliberate, deterministic lock contention.
    it('a writer that locks game_category before game_category_game only ever waits on a concurrent finalize, never deadlocks', async () => {
      const provider = await seedProvider();
      const category = await seedCategory({ sortKey: 'lock_order' });
      const member = await seedGame(provider.id, { name: 'A' }, [category.id]);

      let releaseDefinition: () => void = () => {};
      const definitionBlocked = new Promise<void>((resolve) => {
        releaseDefinition = resolve;
      });
      let definitionReached: () => void = () => {};
      const definitionReachedPromise = new Promise<void>((resolve) => {
        definitionReached = resolve;
      });

      const lockOrder = defineGameSort({
        key: 'lock_order',
        directions: ['asc'],
        paramsSchema: EmptyParamsSchema,
        async rank({ gameIds }) {
          definitionReached();
          await definitionBlocked;
          return gameIds;
        },
      });
      const catalog = createGameSortCatalog([lockOrder]);
      const svc = new GameSortRankingService(db.drizzle, new GameSortService(catalog));

      // Claim commits and releases its own lock immediately; the run then pauses inside
      // the definition, before finalize has attempted anything.
      const rankPromise = svc.rank(category.id);
      await definitionReachedPromise;

      let releaseWriter: () => void = () => {};
      const writerCanCommit = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const writerPromise = db.drizzle.db.transaction(async (tx) => {
        // Locks game_category first, same as updateGame/addGameCategories post-fix.
        await markCategoriesRankDirty(tx, [category.id]);
        // Now let finalize try to acquire the same row - it can only wait, since this
        // writer is not itself waiting on anything finalize holds.
        releaseDefinition();
        await writerCanCommit;
        await tx
          .update(gameCategoryGame)
          .set({ position: 0 })
          .where(
            sql`${gameCategoryGame.categoryId} = ${category.id} AND ${gameCategoryGame.gameId} = ${member.id}`,
          );
      });

      // Give finalize's FOR UPDATE a moment to actually queue up behind the writer's
      // still-open lock - best effort only; the assertion below holds either way.
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseWriter();

      await expect(Promise.all([rankPromise, writerPromise])).resolves.toBeDefined();
    });
  });
});
