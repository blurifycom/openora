import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { CatalogStatsSchema } from '@openora/core/casino/contracts/gaming';
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

async function readStats(client: TestClient) {
  const response = await client.get('/backoffice/gaming/stats');
  expect(response.status).toBe(200);
  return CatalogStatsSchema.parse(await response.json());
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

describe('gaming catalog stats API', () => {
  it('counts catalog rows created through the admin routes', async () => {
    const before = await readStats(admin);
    for (const counts of Object.values(before)) {
      expect(counts.total).toBe(counts.active + counts.inactive);
    }

    const provider = await admin.post('/backoffice/gaming/providers', {
      slug: `stats-provider-${randomUUID()}`,
      name: 'Stats Provider',
    });
    expect(provider.status).toBe(200);
    const category = await admin.post('/backoffice/gaming/categories', {
      slug: `stats-category-${randomUUID()}`,
      name: 'Stats Category',
    });
    expect(category.status).toBe(200);

    await expect(readStats(admin)).resolves.toEqual({
      providers: {
        ...before.providers,
        total: before.providers.total + 1,
        inactive: before.providers.inactive + 1,
      },
      categories: {
        ...before.categories,
        total: before.categories.total + 1,
        active: before.categories.active + 1,
      },
      games: before.games,
    });
  });

  it('denies the stats to a player without game-config permission', async () => {
    const response = await player.get('/backoffice/gaming/stats');
    expect(response.status).toBe(403);
  });

  it('rejects the stats without a session', async () => {
    const response = await testApp.app.request('/backoffice/gaming/stats');
    expect(response.status).toBe(401);
  });
});
