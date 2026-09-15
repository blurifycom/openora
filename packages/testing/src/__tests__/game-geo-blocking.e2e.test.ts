import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
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
    const forbidden = await player.put('/compliance/game-geo-rules', {
      gameId,
      countryCode: 'US',
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const noRules = await admin.get(`/compliance/game-geo-rules?gameId=${gameId}`);
    expect(noRules.status).toBe(200);
    expect(await readJson(noRules)).toEqual([]);

    const start = await startFromBlockedCountry(gameId);
    expect(start.status).toBe(200);
    const admitted = (await readJson(start)) as { roundId: string };
    const balanceAfterAdmittedStart = await getBalance();

    const upsert = await admin.put('/compliance/game-geo-rules', {
      gameId,
      countryCode: 'US',
      reason: 'game licence excludes this country',
    });
    expect(upsert.status).toBe(200);
    const rule = (await readJson(upsert)) as {
      id: string;
      gameId: string;
      countryCode: string;
      reason: string;
    };
    expect(rule).toMatchObject({
      gameId,
      countryCode: 'US',
      reason: 'game licence excludes this country',
    });

    const listed = await admin.get(`/compliance/game-geo-rules?gameId=${gameId}`);
    expect(listed.status).toBe(200);
    expect(await readJson(listed)).toEqual([expect.objectContaining({ id: rule.id, gameId })]);

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

    const deleted = await admin.request(`/compliance/game-geo-rules/${rule.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rule.id, reason: 'licence restored' }),
    });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toMatchObject({ id: rule.id, gameId });

    const emptyAgain = await admin.get(`/compliance/game-geo-rules?gameId=${gameId}`);
    expect(emptyAgain.status).toBe(200);
    expect(await readJson(emptyAgain)).toEqual([]);
  });
});

describe('per-provider geo-blocking lifecycle', () => {
  let gameId: string;
  let providerId: string;

  beforeAll(async () => {
    ({ gameId, providerId } = await seedGame('Per-provider'));
  });

  it('authorizes rule administration and blocks new starts for every game of the provider', async () => {
    const forbidden = await player.put('/compliance/provider-geo-rules', {
      providerId,
      countryCode: 'US',
      reason: 'player must not administer geo policy',
    });
    expect(forbidden.status).toBe(403);

    const unknownProvider = await admin.put('/compliance/provider-geo-rules', {
      providerId: randomUUID(),
      countryCode: 'US',
      reason: 'provider licence excludes this country',
    });
    expect(unknownProvider.status).toBe(404);

    const upsert = await admin.put('/compliance/provider-geo-rules', {
      providerId,
      countryCode: 'US',
      reason: 'provider licence excludes this country',
    });
    expect(upsert.status).toBe(200);
    const rule = (await readJson(upsert)) as { id: string; providerId: string };
    expect(rule).toMatchObject({ providerId, countryCode: 'US' });

    const listed = await admin.get(`/compliance/provider-geo-rules?providerId=${providerId}`);
    expect(listed.status).toBe(200);
    expect(await readJson(listed)).toEqual([expect.objectContaining({ id: rule.id, providerId })]);

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

    const deleted = await admin.request(`/compliance/provider-geo-rules/${rule.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rule.id, reason: 'provider licence restored' }),
    });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toMatchObject({ id: rule.id, providerId });

    const restored = await startFromBlockedCountry(gameId);
    expect(restored.status).toBe(200);
    const { roundId } = (await readJson(restored)) as { roundId: string };
    const end = await player.post(`/gaming/rounds/${roundId}/end`, { roundId });
    expect(end.status).toBe(200);
  });
});
