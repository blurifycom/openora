import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameTag,
  gameTagGame,
} from '@openora/core/casino/schema/gaming';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
import {
  setupTestDb,
  bootTestApp,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let providerId: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await drizzleOf(app.container)
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: 'E2E Filter Game',
      slug: `e2e-filter-game-${randomUUID()}`,
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

async function listIds(query: string) {
  const res = await admin.get(
    `/backoffice/gaming/games?limit=100&providerId=${providerId}&${query}`,
  );
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return (body.items as { id: string }[]).map((g) => g.id).sort();
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);

  const [provider] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({ slug: `e2e-filters-provider-${randomUUID()}`, name: 'E2E Filters', isActive: true })
    .returning();
  providerId = provider!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('admin game list filters e2e', () => {
  it('applies category, tag, type and geo filters from bracket-notation query lists', async () => {
    const dbx = drizzleOf(app.container);
    const [slots, jackpot] = await dbx
      .insert(gameCategory)
      .values([
        { slug: `e2e-slots-${randomUUID()}`, name: 'Slots' },
        { slug: `e2e-jackpot-${randomUUID()}`, name: 'Jackpot' },
      ])
      .returning();
    const [hot, fresh] = await dbx
      .insert(gameTag)
      .values([{ name: `E2E Hot ${randomUUID()}` }, { name: `E2E Fresh ${randomUUID()}` }])
      .returning();

    const full = await seedGame({ gameType: 'original' });
    const partial = await seedGame({ gameType: 'casino' });
    const bare = await seedGame({ gameType: 'sportsbook' });
    await dbx.insert(gameCategoryGame).values([
      { gameId: full.id, categoryId: slots!.id },
      { gameId: full.id, categoryId: jackpot!.id },
      { gameId: partial.id, categoryId: slots!.id },
    ]);
    await dbx.insert(gameTagGame).values([
      { gameId: full.id, tagId: hot!.id },
      { gameId: full.id, tagId: fresh!.id },
      { gameId: partial.id, tagId: hot!.id },
    ]);
    await dbx.insert(gameGeoRule).values([
      { gameId: full.id, countryCode: 'DE', reason: 'licence' },
      { gameId: full.id, countryCode: 'FR', reason: 'licence' },
      { gameId: partial.id, countryCode: 'DE', reason: 'licence' },
    ]);

    expect(await listIds(`categoryIds[]=${slots!.id}&categoryIds[]=${jackpot!.id}`)).toEqual([
      full.id,
    ]);
    expect(await listIds('uncategorized=true')).toEqual([bare.id]);
    expect(await listIds(`tagIds[]=${hot!.id}&tagIds[]=${fresh!.id}`)).toEqual([full.id]);
    expect(await listIds(`tagIds=${hot!.id}`)).toEqual([full.id, partial.id].sort());
    expect(await listIds('gameTypes[]=original&gameTypes[]=sportsbook')).toEqual(
      [full.id, bare.id].sort(),
    );
    expect(await listIds('geoBlocked=false')).toEqual([bare.id]);
    expect(await listIds('geoBlockedCountries[]=DE&geoBlockedCountries[]=FR')).toEqual([full.id]);

    await dbx.insert(providerGeoRule).values({ providerId, countryCode: 'IT', reason: 'licence' });
    expect(await listIds('geoBlockedCountries[]=IT')).toEqual(
      [full.id, partial.id, bare.id].sort(),
    );
    expect(await listIds('geoBlocked=false')).toEqual([]);

    expect(await listIds('geoAvailableCountries[]=DE')).toEqual([bare.id]);
    expect(await listIds('geoAvailableCountries[]=IT')).toEqual([]);
  });

  it('rejects geoBlocked=false combined with geoBlockedCountries', async () => {
    const res = await admin.get(
      '/backoffice/gaming/games?geoBlocked=false&geoBlockedCountries[]=DE',
    );
    expect(res.status).toBe(400);
  });

  it('rejects geoBlocked=true combined with geoAvailableCountries', async () => {
    const res = await admin.get(
      '/backoffice/gaming/games?geoBlocked=true&geoAvailableCountries[]=DE',
    );
    expect(res.status).toBe(400);
  });

  it('rejects a country shared between geoAvailableCountries and geoBlockedCountries', async () => {
    const res = await admin.get(
      '/backoffice/gaming/games?geoAvailableCountries[]=DE&geoBlockedCountries[]=DE',
    );
    expect(res.status).toBe(400);
  });

  it('rejects uncategorized combined with a category filter', async () => {
    const res = await admin.get(
      `/backoffice/gaming/games?uncategorized=true&categoryIds[]=${randomUUID()}`,
    );
    expect(res.status).toBe(400);
  });

  it('filters by review status and counts available pending games on the provider and stats', async () => {
    const pending = await seedGame({ reviewStatus: 'pending', isActive: false });
    const declined = await seedGame({ reviewStatus: 'declined', isActive: false });
    const autoApproved = await seedGame({ reviewStatus: 'auto_approved' });
    await seedGame({ reviewStatus: 'pending', isActive: false, isUnavailable: true });

    expect(await listIds('reviewStatuses[]=declined&reviewStatuses[]=auto_approved')).toEqual(
      [declined.id, autoApproved.id].sort(),
    );
    expect(await listIds('reviewStatuses=pending&isUnavailable=false')).toEqual([pending.id]);

    const providerRes = await admin.get(`/backoffice/gaming/providers/${providerId}`);
    expect(providerRes.status).toBe(200);
    expect(await readJson(providerRes)).toMatchObject({ pendingReviewCount: 1 });

    const statsRes = await admin.get('/backoffice/gaming/stats');
    expect(statsRes.status).toBe(200);
    expect((await readJson(statsRes)).games.pendingReview).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown review status', async () => {
    const res = await admin.get('/backoffice/gaming/games?reviewStatuses[]=exempt');
    expect(res.status).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.app.request('/backoffice/gaming/games?geoBlocked=true');
    expect(res.status).toBe(401);
  });
});

describe('admin game search e2e', () => {
  async function searchIds(body: Record<string, unknown>) {
    const res = await admin.post('/backoffice/gaming/games/search', {
      limit: 100,
      providerId,
      ...body,
    });
    expect(res.status).toBe(200);
    const page = await readJson(res);
    return (page.items as { id: string }[]).map((g) => g.id).sort();
  }

  it('narrows the list by rule clauses sent as a JSON body, alongside the query filters', async () => {
    const dbx = drizzleOf(app.container);
    const [hot] = await dbx
      .insert(gameTag)
      .values({ name: `E2E Search Hot ${randomUUID()}` })
      .returning();
    const original = await seedGame({ gameType: 'original' });
    const casino = await seedGame({ gameType: 'casino' });
    await seedGame({ gameType: 'original' });
    await dbx.insert(gameTagGame).values([
      { gameId: original.id, tagId: hot!.id },
      { gameId: casino.id, tagId: hot!.id },
    ]);
    const byTag = [{ key: 'tags', params: { tagIds: [hot!.id] } }];

    expect(await searchIds({ rules: byTag })).toEqual([original.id, casino.id].sort());
    expect(await searchIds({ rules: byTag, gameTypes: ['original'] })).toEqual([original.id]);
    expect(
      await searchIds({
        rules: [...byTag, { key: 'most_played', params: { periodDays: 7, limit: 5 } }],
      }),
    ).toEqual([]);
  });

  it('rejects an unknown rule key', async () => {
    const res = await admin.post('/backoffice/gaming/games/search', {
      rules: [{ key: 'no_such_rule', params: {} }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.app.request('/backoffice/gaming/games/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [] }),
    });
    expect(res.status).toBe(401);
  });
});
