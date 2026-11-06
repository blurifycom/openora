import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import gamingPlugin from '../plugin.js';

let db: TestDb;

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('gaming');
  gamingPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'games-find-tool',
});

async function seedProvider(slug: string, name: string) {
  return findOneOrThrow(
    await db.drizzle.db.insert(gameProvider).values({ slug, name }).returning(),
    new Error('seedProvider: no row'),
  );
}

async function seedGame(
  providerId: string,
  name: string,
  values: Partial<typeof game.$inferInsert> = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name,
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'direct',
        reviewStatus: 'approved',
        ...values,
      })
      .returning(),
    new Error('seedGame: no row'),
  );
}

async function seedCategory(name: string, values: Partial<typeof gameCategory.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameCategory)
      .values({ name, slug: `category-${randomUUID()}`, ...values })
      .returning(),
    new Error('seedCategory: no row'),
  );
}

async function place(gameId: string, categoryId: string) {
  await db.drizzle.db.insert(gameCategoryGame).values({ gameId, categoryId });
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameCategoryGame}, ${gameCategory}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('games.find through the MCP kernel (real PG)', () => {
  it('lists the games matching every filter by name, each with its categories by id', async () => {
    const kernel = bootKernel();
    const studio = await seedProvider('studio', 'Studio One');
    const other = await seedProvider('other', 'Other Studio');
    const slots = await seedCategory('Slots', { sortOrder: 2 });
    const featured = await seedCategory('Featured', { sortOrder: 1 });
    const blazing = await seedGame(studio.id, 'Blazing 100% Fruits', { isActive: true });
    const fruits = await seedGame(studio.id, 'Fruits Deluxe', {
      isActive: true,
      isUnavailable: true,
    });
    await seedGame(studio.id, 'Fruit Party', { isActive: false });
    await seedGame(other.id, 'Other Fruits', { isActive: true });
    await seedGame(studio.id, 'Pending Fruits', { reviewStatus: 'pending' });
    await place(blazing.id, slots.id);
    await place(blazing.id, featured.id);
    await place(fruits.id, slots.id);

    const result = await kernel.invokeTool(
      'games.find',
      { search: 'FRUITS', providerSlug: 'studio', active: true, reviewStatus: ['approved'] },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        total: 2,
        truncated: false,
        games: [
          {
            gameId: blazing.id,
            name: 'Blazing 100% Fruits',
            slug: blazing.slug,
            provider: 'Studio One',
            gameType: 'casino',
            reviewStatus: 'approved',
            isActive: true,
            isUnavailable: false,
            categories: [
              { gameCategoryId: featured.id, name: 'Featured' },
              { gameCategoryId: slots.id, name: 'Slots' },
            ],
          },
          expect.objectContaining({
            gameId: fruits.id,
            isUnavailable: true,
            categories: [{ gameCategoryId: slots.id, name: 'Slots' }],
          }),
        ],
      },
    });
  });

  it('matches a search literally, narrows to a category, and counts past the limit', async () => {
    const kernel = bootKernel();
    const studio = await seedProvider('studio', 'Studio One');
    const table = await seedCategory('Table');
    const [aces, blackjack, craps] = [
      await seedGame(studio.id, 'Aces'),
      await seedGame(studio.id, 'Blackjack'),
      await seedGame(studio.id, 'Craps'),
    ];
    await seedGame(studio.id, 'Roulette');
    for (const row of [aces, blackjack, craps]) {
      await place(row.id, table.id);
    }

    const narrowed = await kernel.invokeTool(
      'games.find',
      { gameCategoryId: table.id, limit: 2 },
      runContext(),
    );
    expect(narrowed).toMatchObject({
      ok: true,
      output: {
        total: 3,
        truncated: true,
        games: [{ gameId: aces.id }, { gameId: blackjack.id }],
      },
    });

    const wildcard = await kernel.invokeTool('games.find', { search: '%' }, runContext());
    expect(wildcard).toMatchObject({ ok: true, output: { total: 0, games: [] } });
  });

  it('refuses a limit over 50 and an unknown review status', async () => {
    const kernel = bootKernel();

    for (const input of [{ limit: 51 }, { reviewStatus: ['live'] }, { search: '' }]) {
      expect(await kernel.invokeTool('games.find', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});

describe('games.categories through the MCP kernel (real PG)', () => {
  it('lists the categories in lobby order with how many games each holds', async () => {
    const kernel = bootKernel();
    const studio = await seedProvider('studio', 'Studio One');
    const live = await seedCategory('Live', { sortOrder: 2, isActive: true });
    const hidden = await seedCategory('Hidden', { sortOrder: 1, isActive: false });
    const empty = await seedCategory('Empty', { sortOrder: 3 });
    const [first, second] = [await seedGame(studio.id, 'One'), await seedGame(studio.id, 'Two')];
    await place(first.id, live.id);
    await place(second.id, live.id);
    await place(first.id, hidden.id);

    const all = await kernel.invokeTool('games.categories', {}, runContext());
    expect(all).toEqual({
      ok: true,
      output: {
        categories: [
          {
            gameCategoryId: hidden.id,
            slug: hidden.slug,
            name: 'Hidden',
            isActive: false,
            membershipMode: 'manual',
            sortOrder: 1,
            gameCount: 1,
          },
          expect.objectContaining({ gameCategoryId: live.id, gameCount: 2 }),
          expect.objectContaining({ gameCategoryId: empty.id, gameCount: 0 }),
        ],
        truncated: false,
      },
    });

    const active = await kernel.invokeTool('games.categories', { active: true }, runContext());
    expect(active).toMatchObject({
      ok: true,
      output: { categories: [{ gameCategoryId: live.id }, { gameCategoryId: empty.id }] },
    });
  });
});
