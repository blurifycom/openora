import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { GAME_CATALOG_READER } from '@openora/core/contracts';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import {
  asAdmin,
  asPlayer,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

async function seedProvider() {
  const [row] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-sort-provider-${randomUUID()}`,
      name: 'E2E Sort Provider',
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await drizzleOf(app.container)
    .insert(game)
    .values({
      name: 'E2E Sort Game',
      slug: `e2e-sort-game-${randomUUID()}`,
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

async function createCategory(client: TestClient = admin) {
  const res = await client.post('/backoffice/gaming/categories', {
    slug: `e2e-sort-cat-${randomUUID()}`,
    name: 'E2E Sort Category',
  });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function addGameToCategory(gameId: string, categoryId: string) {
  const res = await admin.patch(`/backoffice/gaming/games/${gameId}`, {
    id: gameId,
    categoryIds: [categoryId],
  });
  expect(res.status).toBe(200);
}

async function categoryDetail(categoryId: string) {
  const res = await admin.get(`/backoffice/gaming/categories/${categoryId}`);
  expect(res.status).toBe(200);
  return readJson(res);
}

async function waitForRanked(categoryId: string) {
  await vi.waitFor(async () => {
    const detail = await categoryDetail(categoryId);
    expect(detail.rankedAt).not.toBeNull();
  });
}

async function waitForCategoryOrder(targetApp: TestApp, categoryId: string, expectedIds: string[]) {
  await vi.waitFor(async () => {
    const res = await targetApp.app.request(
      `/gaming/games?categoryId=${categoryId}&page=1&limit=100`,
    );
    expect(res.status).toBe(200);
    const items = (await readJson(res)).items as Array<{ id: string }>;
    expect(items.map((g) => g.id)).toEqual(expectedIds);
  });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 1 });
  admin = await asAdmin(app.app);
  player = await asPlayer(app.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('gaming category sort-config e2e (PATCH /backoffice/gaming/categories/{id})', () => {
  it('switches a category to name-sort and the public list reorders once ranked', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const bravo = await seedGame(provider.id, { name: 'Bravo Game' });
    const alpha = await seedGame(provider.id, { name: 'Alpha Game' });
    await addGameToCategory(bravo.id, category.id);
    await addGameToCategory(alpha.id, category.id);

    const patchRes = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'name',
      sortDirection: 'asc',
    });
    expect(patchRes.status).toBe(200);
    const patched = await readJson(patchRes);
    expect(patched).toMatchObject({ sortKey: 'name', sortDirection: 'asc' });

    await waitForCategoryOrder(app, category.id, [alpha.id, bravo.id]);

    const reader = await app.container
      .get(GAME_CATALOG_READER)
      .listPlayableGamesInCategory(category.id, { limit: 100 });
    expect(reader.map((g) => g.id)).toEqual([alpha.id, bravo.id]);
  });

  it('rejects an unknown sortKey and an invalid direction, leaving the category unchanged', async () => {
    const category = await createCategory();

    const unknownKey = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'not_a_real_sort',
    });
    expect(unknownKey.status).toBe(400);

    const invalidDirection = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'manual',
      sortDirection: 'desc',
    });
    expect(invalidDirection.status).toBe(400);

    const detail = await categoryDetail(category.id);
    expect(detail.sortKey).toBe('manual');
  });

  it('an explicit sortDirection: null resets to the definition default and re-ranks', async () => {
    const category = await createCategory();
    const setDesc = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'name',
      sortDirection: 'desc',
    });
    expect(setDesc.status).toBe(200);
    expect(await readJson(setDesc)).toMatchObject({ sortDirection: 'desc' });

    const resetRes = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortDirection: null,
    });
    expect(resetRes.status).toBe(200);
    const reset = await readJson(resetRes);
    expect(reset).toMatchObject({ sortKey: 'name', sortDirection: 'asc' });

    await vi.waitFor(async () => {
      const detail = await categoryDetail(category.id);
      expect(detail.rankedAt).not.toBeNull();
    });
  });

  it('denies the sort-config PATCH to a player and to an unauthenticated caller', async () => {
    const category = await createCategory();
    const denied = await player.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'name',
    });
    expect(denied.status).toBe(403);
    const anonymous = await app.app.request(`/backoffice/gaming/categories/${category.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: category.id, sortKey: 'name' }),
    });
    expect(anonymous.status).toBe(401);
    const detail = await categoryDetail(category.id);
    expect(detail.sortKey).toBe('manual');
  });
});

describe('gaming category games listing e2e (GET /backoffice/gaming/categories/{id}/games)', () => {
  it('pages category members in manual order, including inactive games', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const active = await seedGame(provider.id, { name: 'Active Member' });
    const inactive = await seedGame(provider.id, { name: 'Inactive Member', isActive: false });
    await addGameToCategory(active.id, category.id);
    await addGameToCategory(inactive.id, category.id);

    const res = await admin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const ids = (body.items as Array<{ id: string; position: number | null }>).map((g) => g.id);
    expect(ids.sort()).toEqual([active.id, inactive.id].sort());
    expect(body.items.every((g: { position: number | null }) => g.position === null)).toBe(true);
    expect(
      body.items.every((g: { pinnedPosition: number | null }) => g.pinnedPosition === null),
    ).toBe(true);
  });

  it('denies the category games listing to a player', async () => {
    const category = await createCategory();
    const res = await player.get(`/backoffice/gaming/categories/${category.id}/games`);
    expect(res.status).toBe(403);
  });
});

describe('gaming category reorder e2e (PUT /backoffice/gaming/categories/{id}/games/order)', () => {
  it('reorders games, audits the change, and materializes matching ranks', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const first = await seedGame(provider.id, { name: 'First' });
    const second = await seedGame(provider.id, { name: 'Second' });
    const third = await seedGame(provider.id, { name: 'Third' });
    await addGameToCategory(first.id, category.id);
    await addGameToCategory(second.id, category.id);
    await addGameToCategory(third.id, category.id);

    const orderedIds = [third.id, first.id, second.id];
    const reorderRes = await admin.put(`/backoffice/gaming/categories/${category.id}/games/order`, {
      id: category.id,
      gameIds: orderedIds,
    });
    expect(reorderRes.status).toBe(200);
    expect(await readJson(reorderRes)).toEqual({
      sortKey: 'manual',
      sortDirection: null,
      sortParams: {},
    });

    const listed = await admin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    const items = (await readJson(listed)).items as Array<{ id: string; position: number | null }>;
    const positionById = new Map(items.map((g) => [g.id, g.position]));
    expect(positionById.get(third.id)).toBe(0);
    expect(positionById.get(first.id)).toBe(1);
    expect(positionById.get(second.id)).toBe(2);

    await vi.waitFor(async () => {
      const res = await admin.get('/audit/logs?action=gaming.category.games_reordered');
      expect(res.status).toBe(200);
      const body = await readJson(res);
      const entry = (
        body.items as Array<{
          resourceId: string;
          before: { gameIds: string[] };
          after: { gameIds: string[] };
        }>
      ).find((row) => row.resourceId === category.id);
      expect(entry).toMatchObject({
        // The full pre-drag effective order (name fallback - none of the three has ever
        // been ranked or manually positioned yet), not only members with a pre-existing
        // manual position.
        before: { gameIds: [first.id, second.id, third.id] },
        after: { gameIds: orderedIds },
      });
    });

    await waitForCategoryOrder(app, category.id, orderedIds);
  });

  it('dragging a game in name-sort mode switches the category to manual, seeding unlisted members from their effective order, without disturbing an existing pin', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' });
    const bravo = await seedGame(provider.id, { name: 'Bravo' });
    const charlie = await seedGame(provider.id, { name: 'Charlie' });
    await addGameToCategory(alpha.id, category.id);
    await addGameToCategory(bravo.id, category.id);
    await addGameToCategory(charlie.id, category.id);

    const sortRes = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'name',
      sortDirection: 'asc',
    });
    expect(sortRes.status).toBe(200);
    await waitForCategoryOrder(app, category.id, [alpha.id, bravo.id, charlie.id]);

    const pinRes = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [{ gameId: bravo.id, position: 0 }],
    });
    expect(pinRes.status).toBe(200);
    await waitForCategoryOrder(app, category.id, [bravo.id, alpha.id, charlie.id]);

    const reorderRes = await admin.put(`/backoffice/gaming/categories/${category.id}/games/order`, {
      id: category.id,
      gameIds: [charlie.id],
    });
    expect(reorderRes.status).toBe(200);
    expect(await readJson(reorderRes)).toMatchObject({ sortKey: 'manual', sortDirection: null });

    const detail = await categoryDetail(category.id);
    expect(detail).toMatchObject({ sortKey: 'manual', sortDirection: null, sortParams: {} });

    const listed = await admin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    const items = (await readJson(listed)).items as Array<{
      id: string;
      position: number | null;
      pinnedPosition: number | null;
    }>;
    const byId = new Map(items.map((g) => [g.id, g]));
    expect(byId.get(charlie.id)?.position).toBe(0);
    expect(byId.get(bravo.id)?.position).toBe(1);
    expect(byId.get(alpha.id)?.position).toBe(2);
    expect(byId.get(bravo.id)?.pinnedPosition).toBe(0);

    await waitForCategoryOrder(app, category.id, [bravo.id, charlie.id, alpha.id]);
  });

  it('rejects a gameId that is not a member of the category, writing nothing', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const outsider = await seedGame(provider.id);
    await addGameToCategory(member.id, category.id);

    const res = await admin.put(`/backoffice/gaming/categories/${category.id}/games/order`, {
      id: category.id,
      gameIds: [member.id, outsider.id],
    });
    expect(res.status).toBe(400);

    const listed = await admin.get(`/backoffice/gaming/categories/${category.id}/games`);
    const items = (await readJson(listed)).items as Array<{ position: number | null }>;
    expect(items.every((g) => g.position === null)).toBe(true);
  });

  it('rejects an empty gameIds list without switching the category to manual sort', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    await addGameToCategory(member.id, category.id);
    const nameSort = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'name',
    });
    expect(nameSort.status).toBe(200);

    const res = await admin.put(`/backoffice/gaming/categories/${category.id}/games/order`, {
      id: category.id,
      gameIds: [],
    });
    expect(res.status).toBe(400);

    expect((await categoryDetail(category.id)).sortKey).toBe('name');
    const listed = await admin.get(`/backoffice/gaming/categories/${category.id}/games`);
    const items = (await readJson(listed)).items as Array<{ position: number | null }>;
    expect(items.every((g) => g.position === null)).toBe(true);
  });

  it('denies the reorder route to a player', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    await addGameToCategory(member.id, category.id);
    const res = await player.put(`/backoffice/gaming/categories/${category.id}/games/order`, {
      id: category.id,
      gameIds: [member.id],
    });
    expect(res.status).toBe(403);
    expect((await categoryDetail(category.id)).sortKey).toBe('manual');
    const listed = await admin.get(`/backoffice/gaming/categories/${category.id}/games`);
    const items = (await readJson(listed)).items as Array<{ position: number | null }>;
    expect(items.every((g) => g.position === null)).toBe(true);
  });
});

describe('gaming category pins e2e (PUT /backoffice/gaming/categories/{id}/games/pins)', () => {
  it('replaces every pin in one call, audits the change, and the public list holds the slot', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' });
    const bravo = await seedGame(provider.id, { name: 'Bravo' });
    const charlie = await seedGame(provider.id, { name: 'Charlie' });
    await addGameToCategory(alpha.id, category.id);
    await addGameToCategory(bravo.id, category.id);
    await addGameToCategory(charlie.id, category.id);

    const pinRes = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [{ gameId: charlie.id, position: 0 }],
    });
    expect(pinRes.status).toBe(200);
    expect(await readJson(pinRes)).toEqual({ pins: [{ gameId: charlie.id, position: 0 }] });

    await waitForCategoryOrder(app, category.id, [charlie.id, alpha.id, bravo.id]);

    const reader = await app.container
      .get(GAME_CATALOG_READER)
      .listPlayableGamesInCategory(category.id, { limit: 100 });
    expect(reader.map((g) => g.id)).toEqual([charlie.id, alpha.id, bravo.id]);

    await vi.waitFor(async () => {
      const res = await admin.get('/audit/logs?action=gaming.category.pins_updated');
      expect(res.status).toBe(200);
      const body = await readJson(res);
      const entry = (
        body.items as Array<{
          resourceId: string;
          before: { pins: unknown[] };
          after: { pins: Array<{ gameId: string; position: number }> };
        }>
      ).find((row) => row.resourceId === category.id);
      expect(entry).toMatchObject({
        before: { pins: [] },
        after: { pins: [{ gameId: charlie.id, position: 0 }] },
      });
    });
  });

  it('swaps two pinned slots in one request and unpins with an empty array', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id);
    const g2 = await seedGame(provider.id);
    await addGameToCategory(g1.id, category.id);
    await addGameToCategory(g2.id, category.id);

    const firstPin = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [
        { gameId: g1.id, position: 0 },
        { gameId: g2.id, position: 1 },
      ],
    });
    expect(firstPin.status).toBe(200);

    const swapped = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [
        { gameId: g1.id, position: 1 },
        { gameId: g2.id, position: 0 },
      ],
    });
    expect(swapped.status).toBe(200);
    expect(await readJson(swapped)).toEqual({
      pins: [
        { gameId: g2.id, position: 0 },
        { gameId: g1.id, position: 1 },
      ],
    });

    const listed = await admin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    const items = (await readJson(listed)).items as Array<{
      id: string;
      pinnedPosition: number | null;
    }>;
    const byId = new Map(items.map((g) => [g.id, g.pinnedPosition]));
    expect(byId.get(g1.id)).toBe(1);
    expect(byId.get(g2.id)).toBe(0);

    const unpinned = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [],
    });
    expect(unpinned.status).toBe(200);
    expect(await readJson(unpinned)).toEqual({ pins: [] });
    const afterUnpin = await admin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    const unpinnedItems = (await readJson(afterUnpin)).items as Array<{
      pinnedPosition: number | null;
    }>;
    expect(unpinnedItems.every((g) => g.pinnedPosition === null)).toBe(true);
  });

  it('rejects a gameId that is not a member, writing nothing', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const outsider = await seedGame(provider.id);
    await addGameToCategory(member.id, category.id);

    const res = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [{ gameId: outsider.id, position: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate position within the same request', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id);
    const g2 = await seedGame(provider.id);
    await addGameToCategory(g1.id, category.id);
    await addGameToCategory(g2.id, category.id);

    const res = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [
        { gameId: g1.id, position: 0 },
        { gameId: g2.id, position: 0 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a pin position past the cap as a 400, not a Postgres ::int overflow', async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id);
    await addGameToCategory(g1.id, category.id);

    const res = await admin.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [{ gameId: g1.id, position: 1_000_000_000_000 }],
    });
    expect(res.status).toBe(400);
  });

  it('denies the pins route to a player and to an unauthenticated caller', async () => {
    const category = await createCategory();
    const denied = await player.put(`/backoffice/gaming/categories/${category.id}/games/pins`, {
      id: category.id,
      pins: [],
    });
    expect(denied.status).toBe(403);

    const anonymous = await app.app.request(
      `/backoffice/gaming/categories/${category.id}/games/pins`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: category.id, pins: [] }),
      },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe('gaming provider isActive re-rank trigger e2e (PATCH /backoffice/gaming/providers/{id})', () => {
  it("re-ranks every category containing that provider's games after an isActive flip", async () => {
    const category = await createCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id);
    await addGameToCategory(g1.id, category.id);
    await waitForRanked(category.id);
    const rankedAtBefore = (await categoryDetail(category.id)).rankedAt;

    const res = await admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      isActive: false,
    });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const detail = await categoryDetail(category.id);
      expect(detail.rankedAt).not.toBe(rankedAtBefore);
    });
  });
});

describe('gaming sort options e2e (GET /backoffice/gaming/sort-options)', () => {
  it('lists the built-in sort definitions with their directions and JSON Schema', async () => {
    const res = await admin.get('/backoffice/gaming/sort-options');
    expect(res.status).toBe(200);
    const options = (await readJson(res)) as Array<{
      key: string;
      directions: string[];
      paramsJsonSchema: unknown;
    }>;
    const byKey = new Map(options.map((o) => [o.key, o]));
    expect(byKey.get('manual')).toMatchObject({ directions: ['asc'] });
    expect(byKey.get('name')).toMatchObject({ directions: ['asc', 'desc'] });
    expect(typeof byKey.get('manual')?.paramsJsonSchema).toBe('object');
  });

  it('denies the sort-options route to a player', async () => {
    const res = await player.get('/backoffice/gaming/sort-options');
    expect(res.status).toBe(403);
  });
});

describe('gaming bulk category-add re-rank trigger e2e', () => {
  it('enqueues a re-rank for exactly the categories named by a bulk category-add call', async () => {
    const category = await createCategory();
    const untouched = await createCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id);

    const res = await admin.post('/backoffice/gaming/games/bulk/categories', {
      gameIds: [g1.id],
      categoryIds: [category.id],
    });
    expect(res.status).toBe(200);

    await waitForRanked(category.id);
    const untouchedDetail = await categoryDetail(untouched.id);
    expect(untouchedDetail.rankedAt).toBeNull();
  });
});

describe('an operator-supplied game sort, rebound via GAME_SORT_CATALOG e2e', () => {
  let customApp: TestApp;
  let customAdmin: TestClient;

  beforeAll(async () => {
    customApp = await bootTestApp({
      plugins: [
        ...(await loadExtensions()),
        {
          id: 'test-custom-game-sort',
          path: fileURLToPath(new URL('../test-custom-game-sort-plugin.ts', import.meta.url)),
        },
      ],
      databaseUrl: db.url,
    });
    await seedMinimal(customApp.container, { playerCount: 0 });
    customAdmin = await asAdmin(customApp.app);
  }, 60_000);

  afterAll(async () => {
    await customApp?.close();
  });

  it('is invoked end to end and its ranks are honored on the public list', async () => {
    const catRes = await customAdmin.post('/backoffice/gaming/categories', {
      slug: `e2e-custom-sort-${randomUUID()}`,
      name: 'Custom Sort Category',
    });
    const category = await readJson(catRes);

    const [row] = await drizzleOf(customApp.container)
      .insert(gameProvider)
      .values({
        slug: `e2e-custom-provider-${randomUUID()}`,
        name: 'Custom Provider',
        isActive: true,
      })
      .returning();
    if (!row) {
      throw new Error('failed to seed a game provider');
    }
    const gameOne = await seedGameFor(customApp, row.id);
    const gameTwo = await seedGameFor(customApp, row.id);
    await customAdmin.patch(`/backoffice/gaming/games/${gameOne.id}`, {
      id: gameOne.id,
      categoryIds: [category.id],
    });
    await customAdmin.patch(`/backoffice/gaming/games/${gameTwo.id}`, {
      id: gameTwo.id,
      categoryIds: [category.id],
    });

    const patchRes = await customAdmin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      sortKey: 'test_id_desc',
    });
    expect(patchRes.status).toBe(200);

    const expectedOrder = [gameOne.id, gameTwo.id].sort().reverse();
    await waitForCategoryOrder(customApp, category.id, expectedOrder);
  });
});

describe('reorder with manual unbound in the sort catalog e2e', () => {
  let noManualApp: TestApp;
  let noManualAdmin: TestClient;

  beforeAll(async () => {
    noManualApp = await bootTestApp({
      plugins: [
        ...(await loadExtensions()),
        {
          id: 'test-no-manual-sort',
          path: fileURLToPath(new URL('../test-no-manual-sort-plugin.ts', import.meta.url)),
        },
      ],
      databaseUrl: db.url,
    });
    await seedMinimal(noManualApp.container, { playerCount: 0 });
    noManualAdmin = await asAdmin(noManualApp.app);
  }, 60_000);

  afterAll(async () => {
    await noManualApp?.close();
  });

  it('rejects the reorder with a field error rather than silently writing positions', async () => {
    const catRes = await noManualAdmin.post('/backoffice/gaming/categories', {
      slug: `e2e-no-manual-${randomUUID()}`,
      name: 'No Manual Category',
    });
    const category = await readJson(catRes);
    const gameOne = await seedGameFor(
      noManualApp,
      (
        await drizzleOf(noManualApp.container)
          .insert(gameProvider)
          .values({
            slug: `e2e-no-manual-provider-${randomUUID()}`,
            name: 'No Manual Provider',
            isActive: true,
          })
          .returning()
      )[0]!.id,
    );
    await noManualAdmin.patch(`/backoffice/gaming/games/${gameOne.id}`, {
      id: gameOne.id,
      categoryIds: [category.id],
    });

    const res = await noManualAdmin.put(
      `/backoffice/gaming/categories/${category.id}/games/order`,
      {
        id: category.id,
        gameIds: [gameOne.id],
      },
    );
    expect(res.status).toBe(400);

    const detail = await noManualAdmin.get(`/backoffice/gaming/categories/${category.id}`);
    expect((await readJson(detail)).sortKey).toBe('manual');
  });
});

async function seedGameFor(target: TestApp, providerId: string) {
  const [row] = await drizzleOf(target.container)
    .insert(game)
    .values({
      name: 'Custom Sort Game',
      slug: `e2e-custom-game-${randomUUID()}`,
      providerId,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game');
  }
  return row;
}
