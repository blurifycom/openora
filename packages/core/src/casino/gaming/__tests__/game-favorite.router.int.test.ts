import { GameSortService } from '../service/game-sort.service.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
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
import { game, gameFavorite, gameProvider } from '../schema/index.js';
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

function router() {
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
  return createGamingRouter({
    gaming,
    providers,
    categories,
    rules,
    membership,
    tags,
    bulk,
    favorites,
    adminGuard: makeAdminGuard(),
    sorts: new GameSortService(sortCatalog),
  });
}

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

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameFavorite}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('gaming router favorites - authentication', () => {
  it('rejects listFavorites with no session', async () => {
    await expect(
      call(router().listFavorites, undefined, { context: testContext() }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects addFavorite with no session', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    await expect(
      call(router().addFavorite, { gameId: target.id }, { context: testContext() }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe('gaming router favorites - per-player isolation', () => {
  it("never returns another player's favorites from listFavorites/listFavoriteIds", async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const playerA = randomUUID();
    const playerB = randomUUID();
    const r = router();

    await call(
      r.addFavorite,
      { gameId: target.id },
      { context: testContext({ auth: { userId: playerA } }) },
    );

    expect(
      await call(r.listFavorites, undefined, {
        context: testContext({ auth: { userId: playerB } }),
      }),
    ).toEqual([]);
    expect(
      await call(r.listFavoriteIds, undefined, {
        context: testContext({ auth: { userId: playerB } }),
      }),
    ).toEqual([]);
    expect(
      await call(r.listFavoriteIds, undefined, {
        context: testContext({ auth: { userId: playerA } }),
      }),
    ).toEqual([target.id]);
  });

  it("cannot remove another player's favorite", async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const playerA = randomUUID();
    const playerB = randomUUID();
    const r = router();
    await call(
      r.addFavorite,
      { gameId: target.id },
      { context: testContext({ auth: { userId: playerA } }) },
    );

    await expect(
      call(
        r.removeFavorite,
        { gameId: target.id },
        {
          context: testContext({ auth: { userId: playerB } }),
        },
      ),
    ).resolves.toEqual({ success: true });

    expect(
      await call(r.listFavoriteIds, undefined, {
        context: testContext({ auth: { userId: playerA } }),
      }),
    ).toEqual([target.id]);
  });
});

describe('gaming router favorites - happy path and typed errors', () => {
  it('adds, lists and removes a favorite through the route contract', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();
    const ctx = { context: testContext({ auth: { userId } }) };
    const r = router();

    await expect(call(r.addFavorite, { gameId: target.id }, ctx)).resolves.toEqual({
      success: true,
    });
    const list = await call(r.listFavorites, undefined, ctx);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(target.id);

    await expect(call(r.removeFavorite, { gameId: target.id }, ctx)).resolves.toEqual({
      success: true,
    });
    expect(await call(r.listFavorites, undefined, ctx)).toEqual([]);
  });

  it('maps an unknown game id to a NOT_FOUND ORPCError', async () => {
    const userId = randomUUID();
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const error = await call(
      router().addFavorite,
      { gameId: unknownId },
      { context: testContext({ auth: { userId } }) },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'NOT_FOUND', unknown>).code).toBe('NOT_FOUND');
  });
});
