import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
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
let testApp: TestApp;
let admin: TestClient;
let player: TestClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected JSON object');
  }
  return value;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 1 });
  admin = await asAdmin(testApp.app);
  player = await asPlayer(testApp.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('gaming category translations API', () => {
  it('round-trips replacement, omitted, and clear updates through gaming outputs', async () => {
    const slug = `translations-${randomUUID()}`;
    const create = await admin.post('/backoffice/gaming/categories', {
      slug,
      name: 'Table Games',
      translations: { DE: { name: 'Tischspiele' } },
    });
    expect(create.status).toBe(200);
    const created = object(await create.json());
    const categoryId = created['id'];
    if (typeof categoryId !== 'string') {
      throw new Error('category response has no id');
    }
    expect(created['translations']).toEqual({ DE: { name: 'Tischspiele' } });

    const adminDetail = await admin.get(`/backoffice/gaming/categories/${categoryId}`);
    expect(adminDetail.status).toBe(200);
    expect(object(await adminDetail.json())['translations']).toEqual({
      DE: { name: 'Tischspiele' },
    });

    const replacement = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      translations: { FR: { name: 'Jeux de table' } },
    });
    expect(replacement.status).toBe(200);
    expect(object(await replacement.json())['translations']).toEqual({
      FR: { name: 'Jeux de table' },
    });

    const omitted = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      name: 'Casino Table Games',
    });
    expect(omitted.status).toBe(200);
    expect(object(await omitted.json())['translations']).toEqual({
      FR: { name: 'Jeux de table' },
    });

    const gaming = await admin.get('/gaming/categories');
    expect(gaming.status).toBe(200);
    expect(await gaming.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: categoryId,
          translations: { FR: { name: 'Jeux de table' } },
        }),
      ]),
    );

    const adminList = await admin.get('/backoffice/gaming/categories?page=1&limit=50');
    expect(adminList.status).toBe(200);
    expect(await adminList.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: categoryId,
            translations: { FR: { name: 'Jeux de table' } },
          }),
        ]),
      }),
    );

    const cleared = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      translations: {},
    });
    expect(cleared.status).toBe(200);
    expect(object(await cleared.json())['translations']).toEqual({});
    const clearedDetail = await admin.get(`/backoffice/gaming/categories/${categoryId}`);
    expect(clearedDetail.status).toBe(200);
    expect(object(await clearedDetail.json())['translations']).toEqual({});
  });

  it('rejects an unauthenticated category mutation', async () => {
    const response = await testApp.app.request('/backoffice/gaming/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: `unauthorized-${randomUUID()}`, name: 'Unauthorized' }),
    });

    expect([401, 403]).toContain(response.status);
  });
});

describe('gaming catalog administration API', () => {
  it('creates and updates a provider, then patches and filters its game', async () => {
    const suffix = randomUUID();
    const providerSlug = `e2e-studio-${suffix}`;
    const createProvider = await admin.post('/backoffice/gaming/providers', {
      slug: providerSlug,
      name: 'E2E Studio',
      aggregatorMappings: [{ aggregator: 'everymatrix', vendorId: `vendor-${suffix}` }],
      logoUrl: 'https://assets.example.test/e2e-studio.svg',
    });
    const createProviderBody: unknown = await createProvider.json();
    expect(createProvider.status, JSON.stringify(createProviderBody)).toBe(200);
    const createdProvider = object(createProviderBody);
    const providerId = createdProvider['id'];
    if (typeof providerId !== 'string') {
      throw new Error('provider response has no id');
    }
    expect(createdProvider).toMatchObject({
      id: providerId,
      slug: providerSlug,
      name: 'E2E Studio',
      aggregatorMappings: [{ aggregator: 'everymatrix', vendorId: `vendor-${suffix}` }],
      logoUrl: 'https://assets.example.test/e2e-studio.svg',
      isActive: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const inactiveProviders = await admin.get(
      `/backoffice/gaming/providers?page=1&limit=100&isActive=false&q=${providerSlug}`,
    );
    expect(inactiveProviders.status).toBe(200);
    expect(await inactiveProviders.json()).toMatchObject({
      items: [expect.objectContaining({ id: providerId, slug: providerSlug, isActive: false })],
      total: 1,
      page: 1,
      limit: 100,
    });

    const providerDetail = await admin.get(`/backoffice/gaming/providers/${providerId}`);
    expect(providerDetail.status).toBe(200);
    expect(await providerDetail.json()).toMatchObject({
      id: providerId,
      slug: providerSlug,
      isActive: false,
    });

    const hiddenProviders = await testApp.app.request('/gaming/providers');
    expect(hiddenProviders.status).toBe(200);
    expect(await hiddenProviders.json()).not.toContainEqual(
      expect.objectContaining({ id: providerId }),
    );

    const hiddenProviderBySlug = await testApp.app.request(`/gaming/providers/${providerSlug}`);
    expect(hiddenProviderBySlug.status).toBe(404);

    const categorySlug = `e2e-category-${suffix}`;
    const createCategory = await admin.post('/backoffice/gaming/categories', {
      slug: categorySlug,
      name: 'E2E Category',
    });
    expect(createCategory.status).toBe(200);
    const createdCategory = object(await createCategory.json());
    const categoryId = createdCategory['id'];
    if (typeof categoryId !== 'string') {
      throw new Error('category response has no id');
    }

    const categoryBySlug = await testApp.app.request(`/gaming/categories/${categorySlug}`);
    expect(categoryBySlug.status).toBe(200);
    expect(await categoryBySlug.json()).toMatchObject({
      id: categoryId,
      slug: categorySlug,
      name: 'E2E Category',
      translations: {},
    });

    const initialGames = await admin.get('/backoffice/gaming/games?page=1&limit=100');
    expect(initialGames.status).toBe(200);
    const initialItems = object(await initialGames.json())['items'];
    if (!Array.isArray(initialItems) || initialItems.length === 0) {
      throw new Error('seeded admin game list is empty');
    }
    const seededGame = object(initialItems[0]);
    const gameId = seededGame['id'];
    if (typeof gameId !== 'string') {
      throw new Error('seeded game response has no id');
    }

    const gameName = `E2E Inactive Game ${suffix}`;
    const unmappedAggregator = await admin.patch(`/backoffice/gaming/games/${gameId}`, {
      id: gameId,
      providerId,
      aggregator: 'direct',
    });
    expect(unmappedAggregator.status).toBe(409);

    const updateGame = await admin.patch(`/backoffice/gaming/games/${gameId}`, {
      id: gameId,
      name: gameName,
      providerId,
      aggregator: 'everymatrix',
      isActive: true,
      metadata: { source: 'e2e' },
      categoryIds: [categoryId],
    });
    expect(updateGame.status).toBe(200);
    expect(await updateGame.json()).toMatchObject({
      id: gameId,
      name: gameName,
      provider: { id: providerId, slug: providerSlug, name: 'E2E Studio' },
      aggregator: 'everymatrix',
      isActive: true,
      metadata: { source: 'e2e' },
      categories: [expect.objectContaining({ id: categoryId, slug: categorySlug })],
    });

    const activeAdminGames = await admin.get(
      `/backoffice/gaming/games?page=1&limit=100&isActive=true&providerId=${providerId}&categoryId=${categoryId}`,
    );
    expect(activeAdminGames.status).toBe(200);
    expect(await activeAdminGames.json()).toMatchObject({
      items: [expect.objectContaining({ id: gameId, isActive: true })],
      total: 1,
    });

    const publicGamesWhileProviderInactive = await testApp.app.request(
      `/gaming/games?page=1&limit=100&providerId=${providerId}`,
    );
    expect(publicGamesWhileProviderInactive.status).toBe(200);
    expect(await publicGamesWhileProviderInactive.json()).toMatchObject({
      items: [],
      total: 0,
    });

    const publicGameWhileProviderInactive = await testApp.app.request(`/gaming/games/${gameId}`);
    expect(publicGameWhileProviderInactive.status).toBe(404);

    const updateProvider = await admin.patch(`/backoffice/gaming/providers/${providerId}`, {
      id: providerId,
      name: 'E2E Studio Updated',
      aggregatorMappings: [{ aggregator: 'everymatrix', vendorId: `updated-${suffix}` }],
      isActive: true,
    });
    expect(updateProvider.status).toBe(200);
    expect(await updateProvider.json()).toMatchObject({
      id: providerId,
      name: 'E2E Studio Updated',
      aggregatorMappings: [{ aggregator: 'everymatrix', vendorId: `updated-${suffix}` }],
      isActive: true,
    });

    const visibleProviders = await testApp.app.request('/gaming/providers');
    expect(visibleProviders.status).toBe(200);
    expect(await visibleProviders.json()).toContainEqual(
      expect.objectContaining({ id: providerId, slug: providerSlug, name: 'E2E Studio Updated' }),
    );

    const visibleProviderBySlug = await testApp.app.request(`/gaming/providers/${providerSlug}`);
    expect(visibleProviderBySlug.status).toBe(200);
    expect(await visibleProviderBySlug.json()).toMatchObject({
      id: providerId,
      slug: providerSlug,
      name: 'E2E Studio Updated',
    });

    const publicGame = await testApp.app.request(`/gaming/games/${gameId}`);
    expect(publicGame.status).toBe(200);
    expect(await publicGame.json()).toMatchObject({
      id: gameId,
      provider: { id: providerId, name: 'E2E Studio Updated' },
      isActive: true,
    });
    const publicGames = await testApp.app.request(
      `/gaming/games?page=1&limit=100&providerId=${providerId}`,
    );
    expect(publicGames.status).toBe(200);
    expect(await publicGames.json()).toMatchObject({
      items: [expect.objectContaining({ id: gameId, isActive: true })],
      total: 1,
    });

    const deactivateGame = await admin.patch(`/backoffice/gaming/games/${gameId}`, {
      id: gameId,
      isActive: false,
    });
    expect(deactivateGame.status).toBe(200);
    expect(await deactivateGame.json()).toMatchObject({ id: gameId, isActive: false });

    const filteredGames = await admin.get(
      `/backoffice/gaming/games?page=1&limit=100&isActive=false&providerId=${providerId}&categoryId=${categoryId}`,
    );
    expect(filteredGames.status).toBe(200);
    expect(await filteredGames.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: gameId,
          provider: expect.objectContaining({ id: providerId }),
          isActive: false,
          categories: [expect.objectContaining({ id: categoryId })],
        }),
      ],
      total: 1,
      page: 1,
      limit: 100,
    });
  });

  it('denies provider creation to an authenticated player without game-config permission', async () => {
    const slug = `denied-provider-${randomUUID()}`;
    const response = await player.post('/backoffice/gaming/providers', {
      slug,
      name: 'Denied Provider',
    });

    expect(response.status).toBe(403);

    const adminList = await admin.get(`/backoffice/gaming/providers?page=1&limit=100&q=${slug}`);
    expect(adminList.status).toBe(200);
    expect(await adminList.json()).toMatchObject({ items: [], total: 0 });
  });
});
