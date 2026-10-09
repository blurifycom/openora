import { GameSortService } from '../service/game-sort.service.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { GameAdapter, PlayEligibilityPort, WalletCommands } from '@openora/core/contracts';
import { createGameCategoryRuleCatalog, createGameSortCatalog } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  testContext,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
  gameTag,
  gameTagGame,
} from '../schema/index.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { createGamingRouter } from '../router/index.js';
import { GamingService } from '../service/gaming.service.js';
import { GameCategoryService } from '../service/game-category.service.js';
import { GameTagService } from '../service/game-tag.service.js';
import { GameProviderService } from '../service/game-provider.service.js';
import { GameCategoryMembershipService } from '../service/game-category-membership.service.js';
import { GameCategoryRuleService } from '../service/game-category-rule.service.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';
import { createDefaultGameCategoryRules } from '../adapters/rules/index.js';
import { GameBulkService } from '../service/game-bulk.service.js';
import { GameFavoriteService } from '../service/game-favorite.service.js';

const CTX = testContext();

let db: TestDb;

function makeRuleCatalog() {
  return createGameCategoryRuleCatalog(
    createDefaultGameCategoryRules(db.drizzle, new DrizzleAdminGameReporting(db.drizzle)),
  );
}

const unrestricted: PlayEligibilityPort = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
});

function makeWalletCommands(): WalletCommands {
  return mock<WalletCommands>({ debit: vi.fn(), credit: vi.fn() });
}

function routerWith(adminGuard: AdminGuard) {
  const events = makeEventBus();
  const gaming = new GamingService(
    db.drizzle,
    events,
    mock<GameAdapter>({ launchGame: vi.fn(), endRound: vi.fn() }),
    unrestricted,
    makeWalletCommands(),
    makeIdentityReader(),
  );
  const providers = new GameProviderService(db.drizzle, events);
  const sortCatalog = createGameSortCatalog(createDefaultGameSorts(db.drizzle));
  const jobQueue = makeJobQueue();
  const rules = new GameCategoryRuleService(db.drizzle, makeRuleCatalog());
  const membership = new GameCategoryMembershipService(db.drizzle, events, jobQueue, rules);
  const categories = new GameCategoryService(
    db.drizzle,
    events,
    jobQueue,
    new GameSortService(sortCatalog),
    rules,
    membership,
  );
  const tags = new GameTagService(db.drizzle, events);
  const bulk = new GameBulkService(db.drizzle, events);
  const favorites = new GameFavoriteService(db.drizzle);
  return {
    router: createGamingRouter({
      gaming,
      providers,
      categories,
      rules,
      membership,
      tags,
      bulk,
      favorites,
      adminGuard,
      sorts: new GameSortService(sortCatalog),
    }),
    events,
  };
}

const denyingGuard = () => makeAdminGuard({ allow: [] });
const allowingGuard = () =>
  makeAdminGuard({ caller: { userId: '88888888-8888-4888-8888-888888888888' } });

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId,
      aggregator: 'direct',
      isActive: true,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game');
  }
  return row;
}

async function seedManyGames(providerId: string, count: number) {
  const rows = await db.drizzle.db
    .insert(game)
    .values(
      Array.from({ length: count }, () => ({
        reviewStatus: 'approved' as const,
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'direct',
        isActive: true,
      })),
    )
    .returning({ id: game.id });
  return rows.map((row) => row.id);
}

async function seedManyTags(count: number) {
  const rows = await db.drizzle.db
    .insert(gameTag)
    .values(Array.from({ length: count }, () => ({ name: `Tag ${randomUUID()}` })))
    .returning({ id: gameTag.id });
  return rows.map((row) => row.id);
}

async function seedTag(overrides: Partial<typeof gameTag.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameTag)
    .values({ name: `Tag ${randomUUID()}`, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game tag');
  }
  return row;
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: `Category ${randomUUID()}`, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game category');
  }
  return row;
}

async function gameTagIdsFor(gameId: string) {
  const rows = await db.drizzle.db
    .select({ tagId: gameTagGame.tagId })
    .from(gameTagGame)
    .where(eq(gameTagGame.gameId, gameId))
    .orderBy(asc(gameTagGame.tagId));
  return rows.map((r) => r.tagId);
}

async function gameCategoryIdsFor(gameId: string) {
  const rows = await db.drizzle.db
    .select({ categoryId: gameCategoryGame.categoryId })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.gameId, gameId))
    .orderBy(asc(gameCategoryGame.categoryId));
  return rows.map((r) => r.categoryId);
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${gameTagGame}, ${game}, ${gameProvider}, ${gameCategory}, ${gameTag} RESTART IDENTITY CASCADE`,
  );
});

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('setGamesActive', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    await expect(
      call(
        routerWith(denyingGuard()).router.setGamesActive,
        { gameIds: [target.id], isActive: false },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, target.id));
    expect(row?.isActive).toBe(true);
  });

  it('rejects an unauthenticated caller the same way', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router } = routerWith(makeAdminGuard({ allow: [] }));
    await expect(
      call(router.setGamesActive, { gameIds: [target.id], isActive: false }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('deactivates by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const untouched = await seedGame(providerB.id);

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], isActive: false },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      providers: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
      unplayableGameIds: [],
      reviewSkippedCount: 0,
    });

    const rows = await db.drizzle.db
      .select({ id: game.id, isActive: game.isActive })
      .from(game)
      .where(inArray(game.id, [gA1.id, gA2.id, gB1.id, untouched.id]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    expect(byId.get(gA1.id)).toBe(false);
    expect(byId.get(gA2.id)).toBe(false);
    expect(byId.get(gB1.id)).toBe(false);
    expect(byId.get(untouched.id)).toBe(true);

    const [providerRow] = await db.drizzle.db
      .select()
      .from(gameProvider)
      .where(eq(gameProvider.id, providerA.id));
    expect(providerRow?.isActive).toBe(false);

    expect(events.emit).toHaveBeenCalledTimes(2);
    const [summaryCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.games.bulk_updated',
    );
    const [providerCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.provider.updated',
    );
    expect(summaryCall?.[1]).toMatchObject({
      operation: 'set_active',
      isActive: false,
      changedGameIds: [gA1.id, gA2.id, gB1.id].sort(),
      changedProviderIds: [providerA.id],
      notFound: { gameIds: [], providerIds: [] },
      bulkOperationId: expect.any(String),
    });
    expect(providerCall?.[1]).toMatchObject({
      providerId: providerA.id,
      before: expect.objectContaining({ isActive: true }),
      after: expect.objectContaining({ isActive: false }),
      bulkOperationId: summaryCall?.[1].bulkOperationId,
    });
  });

  it('reports nonexistent ids in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const ghostGame = randomUUID();
    const ghostProvider = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [target.id, ghostGame], providerIds: [ghostProvider], isActive: false },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      providers: { updatedCount: 0, unchangedCount: 0 },
      notFound: { gameIds: [ghostGame], providerIds: [ghostProvider] },
      unplayableGameIds: [],
      reviewSkippedCount: 0,
    });
    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, target.id));
    expect(row?.isActive).toBe(false);
  });

  it('flags a game left active under a still-inactive provider as unplayable', async () => {
    const activeProvider = await seedProvider();
    const inactiveProvider = await seedProvider({ isActive: false });
    const targeted = await seedGame(activeProvider.id, { isActive: false });
    const strandedGame = await seedGame(inactiveProvider.id, { isActive: false });

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [targeted.id, strandedGame.id], isActive: true },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 2, unchangedCount: 0 });
    expect(result.unplayableGameIds).toEqual([strandedGame.id]);
  });

  it('repeating an identical call reports everything unchanged and emits no second event', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router, events } = routerWith(allowingGuard());

    await call(router.setGamesActive, { gameIds: [target.id], isActive: false }, { context: CTX });
    expect(events.emit).toHaveBeenCalledTimes(1);

    const second = await call(
      router.setGamesActive,
      { gameIds: [target.id], isActive: false },
      { context: CTX },
    );
    expect(second).toEqual({
      games: { updatedCount: 0, unchangedCount: 1 },
      providers: { updatedCount: 0, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
      unplayableGameIds: [],
      reviewSkippedCount: 0,
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('setGamesActive review gate', () => {
  it('a provider-scope enable leaves pending and declined games off and counts them', async () => {
    const provider = await seedProvider();
    const approved = await seedGame(provider.id, { isActive: false });
    const pending = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const declined = await seedGame(provider.id, { reviewStatus: 'declined', isActive: false });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { providerIds: [provider.id], isActive: true },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 1, unchangedCount: 0 });
    expect(result.reviewSkippedCount).toBe(2);
    const rows = await db.drizzle.db
      .select({ id: game.id, isActive: game.isActive, reviewStatus: game.reviewStatus })
      .from(game)
      .where(inArray(game.id, [approved.id, pending.id, declined.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(approved.id)?.isActive).toBe(true);
    expect(byId.get(pending.id)).toMatchObject({ isActive: false, reviewStatus: 'pending' });
    expect(byId.get(declined.id)).toMatchObject({ isActive: false, reviewStatus: 'declined' });
    expect(events.emit.mock.calls.some(([topic]) => topic === 'gaming.games.reviewed')).toBe(false);
  });

  it('enabling unreviewed games by id approves them and emits one reviewed event per prior status', async () => {
    const provider = await seedProvider();
    const pending = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const declined = await seedGame(provider.id, { reviewStatus: 'declined', isActive: false });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [pending.id, declined.id], isActive: true },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 2, unchangedCount: 0 });
    expect(result.reviewSkippedCount).toBe(0);
    const rows = await db.drizzle.db
      .select()
      .from(game)
      .where(inArray(game.id, [pending.id, declined.id]));
    for (const row of rows) {
      expect(row).toMatchObject({ isActive: true, reviewStatus: 'approved' });
      expect(row.reviewedAt).toBeInstanceOf(Date);
    }
    const reviewed = events.emit.mock.calls
      .filter(([topic]) => topic === 'gaming.games.reviewed')
      .map(([, payload]) => payload);
    expect(reviewed).toHaveLength(2);
    expect(reviewed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: 'approve',
          previousStatus: 'pending',
          gameIds: [pending.id],
        }),
        expect.objectContaining({
          decision: 'approve',
          previousStatus: 'declined',
          gameIds: [declined.id],
        }),
      ]),
    );
  });

  it('disabling never touches review status', async () => {
    const provider = await seedProvider();
    const autoApproved = await seedGame(provider.id, { reviewStatus: 'auto_approved' });
    const { router } = routerWith(allowingGuard());

    await call(
      router.setGamesActive,
      { providerIds: [provider.id], isActive: false },
      { context: CTX },
    );

    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, autoApproved.id));
    expect(row).toMatchObject({ isActive: false, reviewStatus: 'auto_approved' });
  });
});

describe('reviewGame', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    await expect(
      call(
        routerWith(denyingGuard()).router.reviewGame,
        { id: target.id, decision: 'approve' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, target.id));
    expect(row).toMatchObject({ isActive: false, reviewStatus: 'pending' });
  });

  it('approve makes the game live, re-ranks its categories and emits the enable and the review', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const category = await seedCategory();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: target.id, categoryId: category.id });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGame,
      { id: target.id, decision: 'approve' },
      { context: CTX },
    );

    expect(result).toMatchObject({ id: target.id, isActive: true, reviewStatus: 'approved' });
    expect(result.reviewedAt).toEqual(expect.any(String));
    const [categoryRow] = await db.drizzle.db
      .select()
      .from(gameCategory)
      .where(eq(gameCategory.id, category.id));
    expect(categoryRow?.rankDirtyAt).not.toBeNull();

    const [bulkCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.games.bulk_updated',
    );
    const [reviewedCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.games.reviewed',
    );
    expect(bulkCall?.[1]).toMatchObject({
      operation: 'set_active',
      isActive: true,
      changedGameIds: [target.id],
      changedProviderIds: [],
      affectedCategoryIds: [category.id],
    });
    expect(reviewedCall?.[1]).toMatchObject({
      decision: 'approve',
      previousStatus: 'pending',
      gameIds: [target.id],
      bulkOperationId: bulkCall?.[1].bulkOperationId,
    });
  });

  it('decline keeps the game off and emits only the review', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGame,
      { id: target.id, decision: 'decline' },
      { context: CTX },
    );

    expect(result).toMatchObject({ isActive: false, reviewStatus: 'declined' });
    expect(result.reviewedAt).toEqual(expect.any(String));
    expect(events.emit.mock.calls.map(([topic]) => topic)).toEqual(['gaming.games.reviewed']);
    expect(events.emit.mock.calls[0]?.[1]).toMatchObject({
      decision: 'decline',
      previousStatus: 'pending',
      gameIds: [target.id],
    });
  });

  it('rejects a game that is not pending with CONFLICT and writes nothing', async () => {
    const provider = await seedProvider();
    const declined = await seedGame(provider.id, { reviewStatus: 'declined', isActive: false });
    const approved = await seedGame(provider.id);

    const { router, events } = routerWith(allowingGuard());
    await expect(
      call(router.reviewGame, { id: declined.id, decision: 'approve' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      call(router.reviewGame, { id: approved.id, decision: 'decline' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await db.drizzle.db
      .select({ id: game.id, isActive: game.isActive, reviewStatus: game.reviewStatus })
      .from(game)
      .where(inArray(game.id, [declined.id, approved.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(declined.id)).toMatchObject({ isActive: false, reviewStatus: 'declined' });
    expect(byId.get(approved.id)).toMatchObject({ isActive: true, reviewStatus: 'approved' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects an unknown id with NOT_FOUND', async () => {
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.reviewGame, { id: UNKNOWN_ID, decision: 'approve' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('approves a game named by an uppercase id', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGame,
      { id: target.id.toUpperCase(), decision: 'approve' },
      { context: CTX },
    );

    expect(result).toMatchObject({ id: target.id, isActive: true, reviewStatus: 'approved' });
  });
});

describe('reviewGames', () => {
  it('rejects a non-privileged caller', async () => {
    const provider = await seedProvider();
    await expect(
      call(
        routerWith(denyingGuard()).router.reviewGames,
        { providerIds: [provider.id], decision: 'approve' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('by provider moves only pending games; a named non-pending game counts as unchanged', async () => {
    const provider = await seedProvider();
    const other = await seedProvider();
    const pendingA = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const pendingB = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const approved = await seedGame(provider.id);
    const declined = await seedGame(provider.id, { reviewStatus: 'declined', isActive: false });
    const namedApproved = await seedGame(other.id);
    const ghost = randomUUID();

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGames,
      {
        providerIds: [provider.id],
        gameIds: [namedApproved.id, ghost],
        decision: 'decline',
      },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 2, unchangedCount: 1 },
      notFound: { gameIds: [ghost], providerIds: [] },
      unplayableGameIds: [],
    });
    const rows = await db.drizzle.db
      .select({ id: game.id, reviewStatus: game.reviewStatus })
      .from(game)
      .where(inArray(game.id, [pendingA.id, pendingB.id, approved.id, declined.id]));
    const byId = new Map(rows.map((r) => [r.id, r.reviewStatus]));
    expect(byId.get(pendingA.id)).toBe('declined');
    expect(byId.get(pendingB.id)).toBe('declined');
    expect(byId.get(approved.id)).toBe('approved');
    expect(byId.get(declined.id)).toBe('declined');

    const [reviewedCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.games.reviewed',
    );
    expect(reviewedCall?.[1]).toMatchObject({
      decision: 'decline',
      previousStatus: 'pending',
      gameIds: [pendingA.id, pendingB.id].sort(),
    });
  });

  it('by provider leaves unavailable pending games in the queue', async () => {
    const provider = await seedProvider();
    const available = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const unavailable = await seedGame(provider.id, {
      reviewStatus: 'pending',
      isActive: false,
      isUnavailable: true,
    });

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGames,
      { providerIds: [provider.id], decision: 'approve' },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 1, unchangedCount: 0 });
    const rows = await db.drizzle.db
      .select({ id: game.id, isActive: game.isActive, reviewStatus: game.reviewStatus })
      .from(game)
      .where(inArray(game.id, [available.id, unavailable.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(available.id)).toMatchObject({ isActive: true, reviewStatus: 'approved' });
    expect(byId.get(unavailable.id)).toMatchObject({ isActive: false, reviewStatus: 'pending' });
  });

  it('flags an approved game under an inactive provider as unplayable', async () => {
    const provider = await seedProvider({ isActive: false });
    const target = await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.reviewGames,
      { providerIds: [provider.id], decision: 'approve' },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 1, unchangedCount: 0 });
    expect(result.unplayableGameIds).toEqual([target.id]);
  });

  it('a repeated call changes nothing and emits nothing', async () => {
    const provider = await seedProvider();
    await seedGame(provider.id, { reviewStatus: 'pending', isActive: false });
    const { router, events } = routerWith(allowingGuard());

    await call(
      router.reviewGames,
      { providerIds: [provider.id], decision: 'approve' },
      { context: CTX },
    );
    events.emit.mockClear();
    const second = await call(
      router.reviewGames,
      { providerIds: [provider.id], decision: 'approve' },
      { context: CTX },
    );

    expect(second.games).toEqual({ updatedCount: 0, unchangedCount: 0 });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('game review status check', () => {
  it('rejects an active game that nobody approved', async () => {
    const provider = await seedProvider();
    const violation = {
      cause: expect.objectContaining({ constraint: 'game_review_status_active_check' }),
    };
    await expect(
      seedGame(provider.id, { reviewStatus: 'pending', isActive: true }),
    ).rejects.toMatchObject(violation);
    await expect(
      seedGame(provider.id, { reviewStatus: 'declined', isActive: true }),
    ).rejects.toMatchObject(violation);
  });
});

describe('addGameTags', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    await expect(
      call(
        routerWith(denyingGuard()).router.addGameTags,
        { gameIds: [target.id], tagIds: [tag.id] },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await gameTagIdsFor(target.id)).toEqual([]);
  });

  it('adds tags by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const tag = await seedTag();

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], tagIds: [tag.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(gA1.id)).toEqual([tag.id]);
    expect(await gameTagIdsFor(gA2.id)).toEqual([tag.id]);
    expect(await gameTagIdsFor(gB1.id)).toEqual([tag.id]);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        operation: 'add_tags',
        tagIds: [tag.id],
        addedLinks: [gA1.id, gA2.id, gB1.id].sort().map((gameId) => ({ gameId, tagIds: [tag.id] })),
      }),
    );
  });

  it('reports a nonexistent gameId in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    const ghostGame = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [target.id, ghostGame], tagIds: [tag.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [ghostGame], providerIds: [] },
    });
  });

  it('rejects the whole call with NOT_FOUND on an unknown tagId, writing nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const realTag = await seedTag();
    const ghostTag = randomUUID();

    const { router } = routerWith(allowingGuard());
    await expect(
      call(
        router.addGameTags,
        { gameIds: [target.id], tagIds: [realTag.id, ghostTag] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await gameTagIdsFor(target.id)).toEqual([]);
  });

  it('is add-only: a pre-existing tag on another slot survives', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const existingTag = await seedTag();
    const newTag = await seedTag();
    await db.drizzle.db.insert(gameTagGame).values({ gameId: target.id, tagId: existingTag.id });

    const { router } = routerWith(allowingGuard());
    await call(router.addGameTags, { gameIds: [target.id], tagIds: [newTag.id] }, { context: CTX });

    expect(await gameTagIdsFor(target.id)).toEqual([existingTag.id, newTag.id].sort());
  });

  it('reports only the missing ids per game on a partial overlap', async () => {
    const provider = await seedProvider();
    const partial = await seedGame(provider.id);
    const fresh = await seedGame(provider.id);
    const tagA = await seedTag();
    const tagB = await seedTag();
    await db.drizzle.db.insert(gameTagGame).values({ gameId: partial.id, tagId: tagA.id });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [partial.id, fresh.id], tagIds: [tagA.id, tagB.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 2, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(partial.id)).toEqual([tagA.id, tagB.id].sort());
    expect(await gameTagIdsFor(fresh.id)).toEqual([tagA.id, tagB.id].sort());
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        addedLinks: [
          { gameId: partial.id, tagIds: [tagB.id] },
          { gameId: fresh.id, tagIds: [tagA.id, tagB.id].sort() },
        ].sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0)),
      }),
    );
  });

  it('repeating an identical call reports everything unchanged and emits no second event', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    const { router, events } = routerWith(allowingGuard());

    await call(router.addGameTags, { gameIds: [target.id], tagIds: [tag.id] }, { context: CTX });
    expect(events.emit).toHaveBeenCalledTimes(1);

    const second = await call(
      router.addGameTags,
      { gameIds: [target.id], tagIds: [tag.id] },
      { context: CTX },
    );
    expect(second).toEqual({
      games: { updatedCount: 0, unchangedCount: 1 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('addGameCategories', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const category = await seedCategory();
    await expect(
      call(
        routerWith(denyingGuard()).router.addGameCategories,
        { gameIds: [target.id], categoryIds: [category.id] },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await gameCategoryIdsFor(target.id)).toEqual([]);
  });

  it('adds categories by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const category = await seedCategory();

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameCategories,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], categoryIds: [category.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameCategoryIdsFor(gA1.id)).toEqual([category.id]);
    expect(await gameCategoryIdsFor(gA2.id)).toEqual([category.id]);
    expect(await gameCategoryIdsFor(gB1.id)).toEqual([category.id]);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        operation: 'add_categories',
        categoryIds: [category.id],
        addedLinks: [gA1.id, gA2.id, gB1.id]
          .sort()
          .map((gameId) => ({ gameId, categoryIds: [category.id] })),
      }),
    );
  });

  it('rejects the whole call with NOT_FOUND on an unknown categoryId, writing nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const realCategory = await seedCategory();
    const ghostCategory = randomUUID();

    const { router } = routerWith(allowingGuard());
    await expect(
      call(
        router.addGameCategories,
        { gameIds: [target.id], categoryIds: [realCategory.id, ghostCategory] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await gameCategoryIdsFor(target.id)).toEqual([]);
  });

  it('is add-only: a pre-existing category survives a second bulk add', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const existingCategory = await seedCategory();
    const newCategory = await seedCategory();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: target.id, categoryId: existingCategory.id });

    const { router } = routerWith(allowingGuard());
    await call(
      router.addGameCategories,
      { gameIds: [target.id], categoryIds: [newCategory.id] },
      { context: CTX },
    );

    expect(await gameCategoryIdsFor(target.id)).toEqual(
      [existingCategory.id, newCategory.id].sort(),
    );
  });

  it('reports a nonexistent providerId in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const category = await seedCategory();
    const ghostProvider = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.addGameCategories,
      { gameIds: [target.id], providerIds: [ghostProvider], categoryIds: [category.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [ghostProvider] },
    });
  });
});

describe('bulk route 5,000-game cap', () => {
  it('rejects a call matching more than 5,000 games and writes nothing', async () => {
    const provider = await seedProvider();
    const gameIds = await seedManyGames(provider.id, 5001);
    const tag = await seedTag();
    const { router } = routerWith(allowingGuard());

    await expect(
      call(router.addGameTags, { providerIds: [provider.id], tagIds: [tag.id] }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { reason: 'too_many_games' } });
    expect(await gameTagIdsFor(gameIds[0]!)).toEqual([]);
  }, 30_000);

  it('adds 7 tags across exactly 5,000 games (35,000 links, past the bind-parameter limit of a VALUES insert)', async () => {
    const provider = await seedProvider();
    const gameIds = await seedManyGames(provider.id, 5000);
    const tagIds = await seedManyTags(7);
    const { router } = routerWith(allowingGuard());

    const result = await call(
      router.addGameTags,
      { providerIds: [provider.id], tagIds },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 5000, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(gameIds[0]!)).toEqual([...tagIds].sort());
  }, 30_000);

  it('caps reviewGames on pending games only', async () => {
    const provider = await seedProvider();
    await seedManyGames(provider.id, 5001);
    const { router } = routerWith(allowingGuard());

    const result = await call(
      router.reviewGames,
      { providerIds: [provider.id], decision: 'approve' },
      { context: CTX },
    );
    expect(result.games).toEqual({ updatedCount: 0, unchangedCount: 0 });

    await db.drizzle.db
      .update(game)
      .set({ isActive: false, reviewStatus: 'pending' })
      .where(eq(game.providerId, provider.id));
    await expect(
      call(
        router.reviewGames,
        { providerIds: [provider.id], decision: 'approve' },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { reason: 'too_many_games' } });
  }, 30_000);

  it('also caps setGamesActive and addGameCategories the same way', async () => {
    const provider = await seedProvider();
    await seedManyGames(provider.id, 5001);
    const category = await seedCategory();
    const { router } = routerWith(allowingGuard());

    await expect(
      call(
        router.setGamesActive,
        { providerIds: [provider.id], isActive: false },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      call(
        router.addGameCategories,
        { providerIds: [provider.id], categoryIds: [category.id] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }, 30_000);
});

describe('bulk route input validation', () => {
  it('rejects a target naming neither gameIds nor providerIds', async () => {
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.setGamesActive, { isActive: true } as never, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects an empty tagIds array', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.addGameTags, { gameIds: [target.id], tagIds: [] }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects when the guarded id is not even a UUID', async () => {
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.setGamesActive, { gameIds: [UNKNOWN_ID], providerIds: ['not-a-uuid'] } as never, {
        context: CTX,
      }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
