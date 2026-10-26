import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CatalogStatsSchema } from '@openora/core/casino/contracts/gaming';
import {
  asAdmin,
  asPlayer,
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
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
  ({ db, app: testApp } = await bootE2e({ seed: { playerCount: 1 } }));
  admin = await asAdmin(testApp.app);
  player = await asPlayer(testApp.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
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
