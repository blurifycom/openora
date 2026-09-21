import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  createGameCategoryRuleCatalog,
  createGameSortCatalog,
  defineGameCategoryRule,
} from '@openora/core/contracts';
import { makeEventBus, makeJobQueue, NO_CLIENT_META } from '../../../testing/mock.js';
import { GameSortService } from '../service/game-sort.service.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { GameCategoryMembershipService } from '../service/game-category-membership.service.js';
import { GameCategoryMembershipTriggerService } from '../service/game-category-membership-trigger.service.js';
import { GameCategoryRuleService } from '../service/game-category-rule.service.js';
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
  let resolutions = 0;
  const rule = defineGameCategoryRule({
    key: 'active_games',
    paramsSchema: z.object({ revision: z.string() }),
    isAffectedBy: () => true,
    resolve: async () => {
      resolutions += 1;
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
    new GameSortService(createGameSortCatalog(createDefaultGameSorts(db.drizzle))),
    rules,
    membership,
  );
  const triggers = new GameCategoryMembershipTriggerService(db.drizzle, events, jobQueue, rules);
  return {
    membership,
    categories,
    events,
    triggers,
    jobQueue,
    resolved,
    resume,
    resolutions: () => resolutions,
  };
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

  it('retries a stale failure instead of reporting it over a newer successful evaluation', async () => {
    const { categoryId, newGameId } = await seed();
    const { membership, resolved, resume } = makeServices({ failFirst: true });
    const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
    await resolved.reached;
    await changeMatches(newGameId);
    await membership.evaluateJob({ categoryId, trigger: 'event' });
    const newerState = await categoryState(categoryId);
    resume.release();
    await expect(older).resolves.toMatchObject({ matchedCount: 1, addedCount: 0, removedCount: 0 });
    const refreshedState = await categoryState(categoryId);
    expect(refreshedState.memberIds).toEqual(newerState.memberIds);
    expect(refreshedState.row.membershipSeq).toBe(newerState.row.membershipSeq + 1);
    expect(refreshedState.row.membershipLastError).toBeNull();
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

  it.each(['status', 'configuration'] as const)(
    'does not invalidate membership when sorting updates its %s',
    async (change) => {
      const { categoryId, oldGameId } = await seed();
      const { membership, categories, resolved, resume, resolutions } = makeServices();
      const evaluation = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
      await resolved.reached;
      const claimedState = await categoryState(categoryId);
      if (change === 'status') {
        await db.drizzle.db
          .update(gameCategory)
          .set({ rankSeq: sql`${gameCategory.rankSeq} + 1`, rankedAt: sql`now()` })
          .where(eq(gameCategory.id, categoryId));
      } else {
        await categories.updateCategory({
          id: categoryId,
          sortKey: 'name',
          sortDirection: 'asc',
          ...ACTOR,
        });
      }
      resume.release();
      await expect(evaluation).resolves.toMatchObject({ matchedCount: 1, addedCount: 1 });
      const finishedState = await categoryState(categoryId);
      expect(finishedState.memberIds).toEqual([oldGameId]);
      expect(finishedState.row.membershipSeq).toBe(claimedState.row.membershipSeq);
      expect(resolutions()).toBe(1);
    },
  );

  it('invalidates changed rule inputs before the queued evaluation starts', async () => {
    const { categoryId, newGameId } = await seed();
    const { membership, triggers, jobQueue, resolved, resume } = makeServices();
    const older = membership.evaluate({ categoryId, trigger: 'admin', actor: ACTOR });
    await resolved.reached;
    const claimedState = await categoryState(categoryId);
    await changeMatches(newGameId);
    triggers.enqueueAffected({ providerIds: [], tagIds: [], playabilityChanged: true });
    await vi.waitFor(() => expect(jobQueue.enqueue).toHaveBeenCalled());
    expect((await categoryState(categoryId)).row.membershipSeq).toBe(
      claimedState.row.membershipSeq + 1,
    );
    resume.release();
    await expect(older).resolves.toMatchObject({ matchedCount: 1, addedCount: 1 });
    expect((await categoryState(categoryId)).memberIds).toEqual([newGameId]);
  });
});
