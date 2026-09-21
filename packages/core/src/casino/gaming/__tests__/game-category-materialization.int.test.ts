import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  createGameCategoryRuleCatalog,
  createGameSortCatalog,
  defineGameCategoryRule,
  defineGameSort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeEventBus, makeJobQueue } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { GameCategoryMembershipService } from '../service/game-category-membership.service.js';
import { GameCategoryRuleService } from '../service/game-category-rule.service.js';
import { GameSortRankingService } from '../service/game-sort-ranking.service.js';
import { GameSortService } from '../service/game-sort.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('category membership and sorting materialization (real PG)', () => {
  it('recomputes an outstanding rank after membership changes and retains surviving pins and positions', async () => {
    const providerId = randomUUID();
    const categoryId = randomUUID();
    const retainedId = randomUUID();
    const departingId = randomUUID();
    const arrivingId = randomUUID();
    await db.drizzle.db.insert(gameProvider).values({
      id: providerId,
      slug: providerId,
      name: 'Provider',
      isActive: true,
    });
    await db.drizzle.db.insert(game).values(
      [retainedId, departingId, arrivingId].map((id) => ({
        id,
        slug: id,
        name: id,
        providerId,
        aggregator: 'direct',
        isActive: id !== arrivingId,
      })),
    );
    await db.drizzle.db.insert(gameCategory).values({
      id: categoryId,
      slug: categoryId,
      name: 'Category',
      sortKey: 'membership_race',
      rankDirtyAt: new Date(),
      membershipMode: 'rule',
      membershipRule: [{ key: 'active_games', params: {} }],
    });
    await db.drizzle.db.insert(gameCategoryGame).values([
      {
        categoryId,
        gameId: retainedId,
        source: 'rule',
        rank: 0,
        position: 7,
        pinnedPosition: 1,
      },
      { categoryId, gameId: departingId, source: 'rule', rank: 1, position: 9 },
    ]);

    const rule = defineGameCategoryRule({
      key: 'active_games',
      paramsSchema: z.object({}),
      async resolve() {
        const rows = await db.drizzle.db
          .select({ id: game.id })
          .from(game)
          .where(eq(game.isActive, true));
        return rows.map(({ id }) => id);
      },
    });
    const rules = new GameCategoryRuleService(db.drizzle, createGameCategoryRuleCatalog([rule]));
    const membership = new GameCategoryMembershipService(
      db.drizzle,
      makeEventBus(),
      makeJobQueue(),
      rules,
    );
    const rankInputs: string[][] = [];
    const sort = defineGameSort({
      key: 'membership_race',
      directions: ['asc'],
      paramsSchema: z.object({}),
      async rank({ gameIds }) {
        rankInputs.push([...gameIds]);
        if (rankInputs.length === 1) {
          await db.drizzle.db
            .update(game)
            .set({ isActive: sql`${game.id} <> ${departingId}::uuid` });
          await membership.evaluate({ categoryId, trigger: 'event' });
        }
        return [...gameIds];
      },
    });
    const ranking = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([sort])),
    );

    await ranking.rank(categoryId);

    const finalMembers = await db.drizzle.db
      .select({
        gameId: gameCategoryGame.gameId,
        rank: gameCategoryGame.rank,
        position: gameCategoryGame.position,
        pinnedPosition: gameCategoryGame.pinnedPosition,
        source: gameCategoryGame.source,
      })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, categoryId))
      .orderBy(asc(gameCategoryGame.rank));
    expect(finalMembers).toEqual([
      { gameId: arrivingId, rank: 0, position: null, pinnedPosition: null, source: 'rule' },
      { gameId: retainedId, rank: 1, position: 7, pinnedPosition: 1, source: 'rule' },
    ]);
    expect(rankInputs.map((ids) => new Set(ids))).toEqual([
      new Set([retainedId, departingId]),
      new Set([retainedId, arrivingId]),
    ]);
  });
});
