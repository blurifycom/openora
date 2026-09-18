import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

type SeededGame = { gameId: string; providerId: string };

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;
const seededGames: SeededGame[] = [];

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function deposit(amount: string) {
  const response = await player.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency: 'USD',
  });
  expect(response.status).toBe(200);
}

async function getBalance(): Promise<string> {
  const response = await player.get('/wallet/balance');
  expect(response.status).toBe(200);
  return (await readJson(response)).balance as string;
}

async function listRounds() {
  const response = await player.get('/gaming/rounds');
  expect(response.status).toBe(200);
  return (await readJson(response)) as Array<{ id: string; status: string }>;
}

function startFromBlockedCountry(gameId: string) {
  return player.request('/gaming/rounds/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.40' },
    body: JSON.stringify({ gameId, currency: 'USD', betAmount: '10' }),
  });
}

async function auditEntries(resourceId: string, action: string) {
  const response = await admin.get(`/audit/logs?resourceId=${resourceId}&action=${action}`);
  expect(response.status).toBe(200);
  return (await readJson(response)).items as Array<Record<string, unknown>>;
}

async function seedGame(label: string): Promise<SeededGame> {
  const drizzle = app.container.get(DRIZZLE).db;
  const [provider] = await drizzle
    .insert(gameProvider)
    .values({ slug: `game-geo-e2e-${randomUUID()}`, name: `${label} Studio`, isActive: true })
    .returning();
  if (!provider) {
    throw new Error(`failed to seed a provider for the ${label} geo E2E flow`);
  }
  const [created] = await drizzle
    .insert(game)
    .values({
      name: `${label} Game`,
      slug: `game-geo-e2e-${randomUUID()}`,
      providerId: provider.id,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  if (!created) {
    throw new Error(`failed to seed a game for the ${label} geo E2E flow`);
  }
  const seeded = { gameId: created.id, providerId: provider.id };
  seededGames.push(seeded);
  return seeded;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();
  const geoFixturePath = fileURLToPath(
    new URL('./fixtures/test-game-geo-ip-plugin.ts', import.meta.url),
  );
  app = await bootTestApp({
    plugins: [...basePlugins, { id: 'test-game-geo-ip', path: geoFixturePath }],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);

  const registered = await registerAndMaterializePlayer(app, {
    email: `game-geo-${randomUUID()}@e2e.test`,
  });
  player = registered.client;
  await deposit('100');
}, 60_000);

afterAll(async () => {
  if (app) {
    const drizzle = app.container.get(DRIZZLE).db;
    for (const { gameId, providerId } of seededGames) {
      await drizzle.delete(gameRound).where(eq(gameRound.gameId, gameId));
      await drizzle.delete(gameGeoRule).where(eq(gameGeoRule.gameId, gameId));
      await drizzle.delete(game).where(eq(game.id, gameId));
      await drizzle.delete(providerGeoRule).where(eq(providerGeoRule.providerId, providerId));
      await drizzle.delete(gameProvider).where(eq(gameProvider.id, providerId));
    }
  }
  await app?.close();
  await db?.dispose();
});

describe('per-game geo-blocking lifecycle', () => {
  let gameId: string;

  beforeAll(async () => {
    ({ gameId } = await seedGame('Per-game'));
  });

  it('authorizes rule administration, blocks only new starts, and lets an admitted round finish', async () => {
    const forbidden = await player.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['US'],
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const noRules = await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`);
    expect(noRules.status).toBe(200);
    expect(await readJson(noRules)).toEqual({ items: [], total: 0, page: 1, limit: 100 });

    const malformedFilter = await admin.get('/compliance/game-geo-rules?gameIds[]=not-a-uuid');
    expect(malformedFilter.status).toBe(400);

    const start = await startFromBlockedCountry(gameId);
    expect(start.status).toBe(200);
    const admitted = (await readJson(start)) as { roundId: string };
    const balanceAfterAdmittedStart = await getBalance();

    const upsert = await admin.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['US'],
      reason: 'game licence excludes this country',
    });
    expect(upsert.status).toBe(200);
    const [rule] = (await readJson(upsert)) as [
      {
        id: string;
        gameId: string;
        countryCode: string;
        reason: string;
      },
    ];
    expect(rule).toMatchObject({
      gameId,
      countryCode: 'US',
      reason: 'game licence excludes this country',
    });

    const listed = await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`);
    expect(listed.status).toBe(200);
    expect(await readJson(listed)).toEqual({
      items: [expect.objectContaining({ id: rule.id, gameId })],
      total: 1,
      page: 1,
      limit: 100,
    });

    const end = await player.post(`/gaming/rounds/${admitted.roundId}/end`, {
      roundId: admitted.roundId,
    });
    expect(end.status).toBe(200);
    expect(await readJson(end)).toEqual({
      success: true,
      winAmount: '0',
    });
    expect(await getBalance()).toBe(balanceAfterAdmittedStart);

    const roundsBeforeBlockedStart = await listRounds();
    expect(roundsBeforeBlockedStart).toContainEqual(
      expect.objectContaining({ id: admitted.roundId, status: 'completed' }),
    );

    const blocked = await startFromBlockedCountry(gameId);
    expect(blocked.status).toBe(409);
    expect(await readJson(blocked)).toMatchObject({
      code: 'CONFLICT',
      data: { reason: 'game_block', countryCode: 'US' },
    });
    expect(await getBalance()).toBe(balanceAfterAdmittedStart);
    expect(await listRounds()).toEqual(roundsBeforeBlockedStart);

    const deleted = await admin.request(`/compliance/game-geo-rules/${gameId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ countryCodes: ['US'], reason: 'licence restored' }),
    });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toEqual([expect.objectContaining({ id: rule.id, gameId })]);

    const emptyAgain = await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`);
    expect(emptyAgain.status).toBe(200);
    expect(await readJson(emptyAgain)).toMatchObject({ items: [], total: 0 });
  });
});

describe('per-provider geo-blocking lifecycle', () => {
  let gameId: string;
  let providerId: string;

  beforeAll(async () => {
    ({ gameId, providerId } = await seedGame('Per-provider'));
  });

  it('authorizes rule administration and blocks new starts for every game of the provider', async () => {
    const forbidden = await player.put(`/compliance/provider-geo-rules/${providerId}`, {
      countryCodes: ['US'],
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const unknownProvider = await admin.put(`/compliance/provider-geo-rules/${randomUUID()}`, {
      countryCodes: ['US'],
      reason: 'provider licence excludes this country',
    });
    expect(unknownProvider.status).toBe(404);

    const upsert = await admin.put(`/compliance/provider-geo-rules/${providerId}`, {
      countryCodes: ['US'],
      reason: 'provider licence excludes this country',
    });
    expect(upsert.status).toBe(200);
    const [rule] = (await readJson(upsert)) as [{ id: string; providerId: string }];
    expect(rule).toMatchObject({ providerId, countryCode: 'US' });

    const drizzle = app.container.get(DRIZZLE).db;
    const [adminUser] = await drizzle
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, 'admin@oss.dev'));
    await vi.waitFor(async () => {
      expect(await auditEntries(rule.id, 'compliance.provider-geo-rule.upserted')).toEqual([
        expect.objectContaining({
          actorType: 'admin',
          actorId: adminUser?.id,
          resourceType: 'provider-geo-rule',
          resourceId: rule.id,
          before: null,
          after: {
            state: expect.objectContaining({ id: rule.id, providerId, countryCode: 'US' }),
            reason: 'provider licence excludes this country',
            providerId,
            countryCode: 'US',
          },
        }),
      ]);
    });

    const listed = await admin.get(`/compliance/provider-geo-rules?providerIds[]=${providerId}`);
    expect(listed.status).toBe(200);
    expect(await readJson(listed)).toEqual({
      items: [expect.objectContaining({ id: rule.id, providerId })],
      total: 1,
      page: 1,
      limit: 100,
    });

    const forbiddenList = await player.get(
      `/compliance/provider-geo-rules?providerIds[]=${providerId}`,
    );
    expect(forbiddenList.status).toBe(403);

    const balanceBeforeBlockedStart = await getBalance();
    const roundsBeforeBlockedStart = await listRounds();

    const blocked = await startFromBlockedCountry(gameId);
    expect(blocked.status).toBe(409);
    expect(await readJson(blocked)).toMatchObject({
      code: 'CONFLICT',
      data: { reason: 'provider_block', countryCode: 'US' },
    });
    expect(await getBalance()).toBe(balanceBeforeBlockedStart);
    expect(await listRounds()).toEqual(roundsBeforeBlockedStart);

    const deleted = await admin.request(`/compliance/provider-geo-rules/${providerId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        countryCodes: ['US'],
        reason: 'provider licence restored',
      }),
    });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toEqual([expect.objectContaining({ id: rule.id, providerId })]);
    await vi.waitFor(async () => {
      expect(await auditEntries(rule.id, 'compliance.provider-geo-rule.deleted')).toEqual([
        expect.objectContaining({
          actorType: 'admin',
          actorId: adminUser?.id,
          resourceType: 'provider-geo-rule',
          resourceId: rule.id,
          before: expect.objectContaining({ id: rule.id, providerId, countryCode: 'US' }),
          after: {
            state: null,
            reason: 'provider licence restored',
            providerId,
            countryCode: 'US',
          },
        }),
      ]);
    });

    const restored = await startFromBlockedCountry(gameId);
    expect(restored.status).toBe(200);
    const { roundId } = (await readJson(restored)) as { roundId: string };
    const end = await player.post(`/gaming/rounds/${roundId}/end`, { roundId });
    expect(end.status).toBe(200);
  });
});

describe('multi-country geo-blocking', () => {
  it('blocks a game in many countries with one request, all or nothing', async () => {
    const { gameId } = await seedGame('Bulk per-game');

    const forbidden = await player.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['US', 'GB'],
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const unknownGame = await admin.put(`/compliance/game-geo-rules/${randomUUID()}`, {
      countryCodes: ['US', 'GB'],
      reason: 'game licence excludes these countries',
    });
    expect(unknownGame.status).toBe(404);

    const malformedId = await admin.put('/compliance/game-geo-rules/not-a-uuid', {
      countryCodes: ['US'],
      reason: 'game licence excludes these countries',
    });
    expect(malformedId.status).toBe(400);

    const empty = await admin.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: [],
      reason: 'game licence excludes these countries',
    });
    expect(empty.status).toBe(400);

    const malformed = await admin.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['US', 'usa'],
      reason: 'game licence excludes these countries',
    });
    expect(malformed.status).toBe(400);
    expect(
      await readJson(await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`)),
    ).toMatchObject({ items: [], total: 0 });

    const first = await admin.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['GB'],
      reason: 'original reason',
    });
    expect(first.status).toBe(200);
    const [existing] = (await readJson(first)) as [{ id: string }];

    const bulk = await admin.put(`/compliance/game-geo-rules/${gameId}`, {
      countryCodes: ['US', 'GB', 'FR', 'US'],
      reason: 'game licence excludes these countries',
    });
    expect(bulk.status).toBe(200);
    const rules = (await readJson(bulk)) as Array<{ id: string; countryCode: string }>;
    expect(rules).toEqual([
      expect.objectContaining({ gameId, countryCode: 'FR' }),
      expect.objectContaining({
        id: existing.id,
        gameId,
        countryCode: 'GB',
        reason: 'game licence excludes these countries',
      }),
      expect.objectContaining({ gameId, countryCode: 'US' }),
    ]);

    const listed = await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`);
    expect(await readJson(listed)).toMatchObject({ total: 3 });

    await vi.waitFor(async () => {
      expect(await auditEntries(existing.id, 'compliance.game-geo-rule.upserted')).toHaveLength(2);
    });

    const blocked = await startFromBlockedCountry(gameId);
    expect(blocked.status).toBe(409);
    expect(await readJson(blocked)).toMatchObject({
      data: { reason: 'game_block', countryCode: 'US' },
    });

    const deleteRules = (countryCodes: string[], client: TestClient = admin) =>
      client.request(`/compliance/game-geo-rules/${gameId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ countryCodes, reason: 'licence restored' }),
      });

    expect((await deleteRules(['US', 'GB'], player)).status).toBe(403);

    const partlyMissing = await deleteRules(['US', 'DE']);
    expect(partlyMissing.status).toBe(404);
    expect(
      await readJson(await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`)),
    ).toMatchObject({ total: 3 });

    const removed = await deleteRules(['US', 'GB', 'US']);
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toEqual([
      expect.objectContaining({ id: existing.id, countryCode: 'GB' }),
      expect.objectContaining({ countryCode: 'US' }),
    ]);
    expect(
      await readJson(await admin.get(`/compliance/game-geo-rules?gameIds[]=${gameId}`)),
    ).toMatchObject({ items: [expect.objectContaining({ countryCode: 'FR' })], total: 1 });

    await vi.waitFor(async () => {
      expect(await auditEntries(existing.id, 'compliance.game-geo-rule.deleted')).toEqual([
        expect.objectContaining({
          resourceType: 'game-geo-rule',
          resourceId: existing.id,
          after: expect.objectContaining({ state: null, reason: 'licence restored' }),
        }),
      ]);
    });

    const restored = await startFromBlockedCountry(gameId);
    expect(restored.status).toBe(200);
    const { roundId } = (await readJson(restored)) as { roundId: string };
    expect((await player.post(`/gaming/rounds/${roundId}/end`, { roundId })).status).toBe(200);
  });

  it('blocks a provider in many countries with one request, audited per rule', async () => {
    const { gameId, providerId } = await seedGame('Bulk per-provider');

    const forbidden = await player.put(`/compliance/provider-geo-rules/${providerId}`, {
      countryCodes: ['US', 'GB'],
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const unknownProvider = await admin.put(`/compliance/provider-geo-rules/${randomUUID()}`, {
      countryCodes: ['US', 'GB'],
      reason: 'provider licence excludes these countries',
    });
    expect(unknownProvider.status).toBe(404);

    const bulk = await admin.put(`/compliance/provider-geo-rules/${providerId}`, {
      countryCodes: ['US', 'GB', 'DE'],
      reason: 'provider licence excludes these countries',
    });
    expect(bulk.status).toBe(200);
    const rules = (await readJson(bulk)) as Array<{ id: string; countryCode: string }>;
    expect(rules.map((rule) => rule.countryCode)).toEqual(['DE', 'GB', 'US']);

    const listed = await admin.get(`/compliance/provider-geo-rules?providerIds[]=${providerId}`);
    expect(await readJson(listed)).toMatchObject({ total: 3 });

    await vi.waitFor(async () => {
      for (const rule of rules) {
        expect(await auditEntries(rule.id, 'compliance.provider-geo-rule.upserted')).toEqual([
          expect.objectContaining({
            resourceType: 'provider-geo-rule',
            resourceId: rule.id,
            before: null,
            after: expect.objectContaining({
              reason: 'provider licence excludes these countries',
              providerId,
              countryCode: rule.countryCode,
            }),
          }),
        ]);
      }
    });

    const blocked = await startFromBlockedCountry(gameId);
    expect(blocked.status).toBe(409);
    expect(await readJson(blocked)).toMatchObject({
      data: { reason: 'provider_block', countryCode: 'US' },
    });

    const deleteRules = (countryCodes: string[], client: TestClient = admin) =>
      client.request(`/compliance/provider-geo-rules/${providerId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ countryCodes, reason: 'provider licence restored' }),
      });

    expect((await deleteRules(['US'], player)).status).toBe(403);
    expect((await deleteRules(['US', 'FR'])).status).toBe(404);

    const removed = await deleteRules(['US', 'GB', 'DE']);
    expect(removed.status).toBe(200);
    expect(((await readJson(removed)) as typeof rules).map((rule) => rule.id)).toEqual(
      rules.map((rule) => rule.id),
    );
    expect(
      await readJson(await admin.get(`/compliance/provider-geo-rules?providerIds[]=${providerId}`)),
    ).toMatchObject({ items: [], total: 0 });

    await vi.waitFor(async () => {
      for (const rule of rules) {
        expect(await auditEntries(rule.id, 'compliance.provider-geo-rule.deleted')).toEqual([
          expect.objectContaining({
            resourceType: 'provider-geo-rule',
            resourceId: rule.id,
            after: expect.objectContaining({
              state: null,
              reason: 'provider licence restored',
              countryCode: rule.countryCode,
            }),
          }),
        ]);
      }
    });

    const restored = await startFromBlockedCountry(gameId);
    expect(restored.status).toBe(200);
    const { roundId } = (await readJson(restored)) as { roundId: string };
    expect((await player.post(`/gaming/rounds/${roundId}/end`, { roundId })).status).toBe(200);
  });
});
