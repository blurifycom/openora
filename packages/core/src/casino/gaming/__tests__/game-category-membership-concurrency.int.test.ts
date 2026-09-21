import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  createGameCategoryRuleCatalog,
  createGameSortCatalog,
  defineGameCategoryRule,
} from '@openora/core/contracts';
import { makeEventBus, makeJobQueue, NO_CLIENT_META } from '../../../testing/mock.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { GameCategoryMembershipService } from '../service/game-category-membership.service.js';
import {
  GameCategoryRuleInvalidError,
  GameCategoryRuleService,
} from '../service/game-category-rule.service.js';
import { GameCategoryService } from '../service/game-category.service.js';

let db: TestDb;
const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };
const RULE = [{ key: 'active_games', params: { revision: 'original' } }];

function gate() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

function makeServices({ failFirst = false } = {}) {
  const resolved = gate();
  const resume = gate();
  let first = true;
  const rule = defineGameCategoryRule({
    key: 'active_games',
    paramsSchema: z.object({ revision: z.string() }),
    resolve: async () => {
      const rows = await db.drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(eq(game.isActive, true));
      if (first) {
        first = false;
        resolved.release();
        await resume.reached;
        if (failFirst) {
          throw new Error('The earlier evaluation failed');
        }
      }
      return rows.map((row) => row.id);
    },
  });
  const events = makeEventBus();
  const jobQueue = makeJobQueue();
  const rules = new GameCategoryRuleService(db.drizzle, createGameCategoryRuleCatalog([rule]));
  const membership = new GameCategoryMembershipService(db.drizzle, events, jobQueue, rules);
  const categories = new GameCategoryService(
    db.drizzle,
    events,
    jobQueue,
    createGameSortCatalog(createDefaultGameSorts(db.drizzle)),
    rules,
    membership,
  );
  return { membership, categories, events, resolved, resume };
}

async function seed() {
  const providerId = randomUUID();
  const oldGameId = randomUUID();
  const newGameId = randomUUID();
  const categoryId = randomUUID();
  await db.drizzle.db.insert(gameProvider).values({
    id: providerId,
    slug: providerId,
    name: 'Provider',
  });
  await db.drizzle.db.insert(game).values(
    [oldGameId, newGameId].map((id) => ({
      id,
      slug: id,
      name: id,
      providerId,
      aggregator: 'direct',
      isActive: id === oldGameId,
    })),
  );
  await db.drizzle.db.insert(gameCategory).values({
    id: categoryId,
    slug: categoryId,
    name: 'Category',
    membershipMode: 'rule',
    membershipRule: RULE,
  });
  return { categoryId, oldGameId, newGameId };
}

async function changeMatches(newGameId: typeof game.$inferSelect.id) {
  await db.drizzle.db.update(game).set({ isActive: sql`${game.id} = ${newGameId}::uuid` });
}

async function categoryState(categoryId: typeof gameCategory.$inferSelect.id) {
  const [row] = await db.drizzle.db
    .select()
    .from(gameCategory)
    .where(eq(gameCategory.id, categoryId));
  if (!row) {
    throw new Error('Seeded category disappeared');
  }
  const members = await db.drizzle.db
    .select({ gameId: gameCategoryGame.gameId })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.categoryId, categoryId));
  return { row, memberIds: members.map((member) => member.gameId) };
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameCategory}, ${gameProvider} CASCADE`);
});

describe('rule membership evaluation concurrency (real PG)', () => {
  it('re-resolves an older snapshot after a newer evaluation commits', async () => {
    const { categoryId, newGameId } = await seed();
    const { membership, events, resolved, resume } = makeServices();
    const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
    await resolved.reached;
    await changeMatches(newGameId);
    await membership.evaluateJob({ categoryId, trigger: 'event' });
    expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
    resume.release();
    await expect(older).resolves.toMatchObject({ matchedCount: 1, addedCount: 0, removedCount: 0 });
    expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
    expect(events.emit).toHaveBeenLastCalledWith(
      'gaming.category.membership_evaluated',
      expect.objectContaining({ addedGameIds: [], removedGameIds: [], trigger: 'admin' }),
    );
  });

  it('does not stamp a stale failure over a newer successful evaluation', async () => {
    const { categoryId, newGameId } = await seed();
    const { membership, resolved, resume } = makeServices({ failFirst: true });
    const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
    const rejected = expect(older).rejects.toThrow(GameCategoryRuleInvalidError);
    await resolved.reached;
    await changeMatches(newGameId);
    await membership.evaluateJob({ categoryId, trigger: 'event' });
    const newerState = await categoryState(categoryId);
    resume.release();
    await rejected;
    expect(await categoryState(categoryId)).toEqual(newerState);
    expect(newerState.row.membershipLastError).toBeNull();
  });

  it.each(['mode', 'rule'] as const)(
    'invalidates the older snapshot when %s changes away and back',
    async (change) => {
      const { categoryId, newGameId } = await seed();
      const { membership, categories, resolved, resume } = makeServices();
      const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
      await resolved.reached;
      await changeMatches(newGameId);
      await categories.updateCategory({
        id: categoryId,
        ...(change === 'mode'
          ? { membershipMode: 'manual' as const }
          : { membershipRule: [{ key: 'active_games', params: { revision: 'changed' } }] }),
        ...ACTOR,
      });
      await categories.updateCategory({
        id: categoryId,
        membershipMode: 'rule',
        membershipRule: RULE,
        ...ACTOR,
      });
      expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
      resume.release();
      await expect(older).resolves.toMatchObject({ addedCount: 0, removedCount: 0 });
      expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
    },
  );

  it('does not stamp an older failure after the category switches to manual', async () => {
    const { categoryId } = await seed();
    const { membership, categories, resolved, resume } = makeServices({ failFirst: true });
    const older = membership.evaluateJob({ categoryId, trigger: 'schedule' });
    await resolved.reached;
    await categories.updateCategory({ id: categoryId, membershipMode: 'manual', ...ACTOR });
    await categories.updateCategory({
      id: categoryId,
      membershipRule: [{ key: 'active_games', params: { revision: 'changed' } }],
      ...ACTOR,
    });
    const manualState = await categoryState(categoryId);
    expect(manualState.row.membershipEvaluatedAt).toBeNull();
    resume.release();
    await older;
    expect(await categoryState(categoryId)).toEqual(manualState);
  });

  it.each(['mode', 'rule'] as const)(
    're-resolves after an atomic %s roundtrip with no evaluation or timestamp change',
    async (change) => {
      const { categoryId, newGameId } = await seed();
      const { membership, resolved, resume } = makeServices();
      const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
      await resolved.reached;
      const original = await categoryState(categoryId);
      await changeMatches(newGameId);
      await db.drizzle.db.transaction(async (tx) => {
        await tx
          .update(gameCategory)
          .set({
            ...(change === 'mode'
              ? { membershipMode: 'manual' as const }
              : { membershipRule: [{ key: 'active_games', params: { revision: 'changed' } }] }),
            updatedAt: sql`${gameCategory.updatedAt}`,
          })
          .where(eq(gameCategory.id, categoryId));
        await tx
          .update(gameCategory)
          .set({
            membershipMode: 'rule',
            membershipRule: RULE,
            updatedAt: sql`${gameCategory.updatedAt}`,
          })
          .where(eq(gameCategory.id, categoryId));
      });
      expect(await categoryState(categoryId)).toEqual(original);
      resume.release();
      await expect(older).resolves.toMatchObject({ matchedCount: 1, addedCount: 1 });
      expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
    },
  );
});
