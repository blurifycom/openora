import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { gameGeoRule } from '@openora/core/compliance/schema';
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

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;
let gameId: string;

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

  const [createdGame] = await app.container
    .get(DRIZZLE)
    .db.insert(game)
    .values({ name: 'Game Geo E2E Game', provider: 'mock', category: 'slots' })
    .returning();
  if (!createdGame) {
    throw new Error('failed to seed a game for the per-game geo E2E flow');
  }
  gameId = createdGame.id;
  await deposit('100');
}, 60_000);

afterAll(async () => {
  if (app && gameId) {
    await app.container.get(DRIZZLE).db.delete(gameRound).where(eq(gameRound.gameId, gameId));
    await app.container.get(DRIZZLE).db.delete(gameGeoRule).where(eq(gameGeoRule.gameId, gameId));
    await app.container.get(DRIZZLE).db.delete(game).where(eq(game.id, gameId));
  }
  await app?.close();
  await db?.dispose();
});

describe('per-game geo-blocking lifecycle', () => {
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

    const start = await player.request('/gaming/rounds/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.40' },
      body: JSON.stringify({ gameId, currency: 'USD', betAmount: '10' }),
    });
    expect(start.status).toBe(200);
    const admitted = (await readJson(start)) as { roundId: string };
    expect(await getBalance()).toBe('90.000000000000000000');

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

    const balanceBeforeBlockedStart = await getBalance();
    const roundsBeforeBlockedStart = await listRounds();
    expect(roundsBeforeBlockedStart).toEqual([
      expect.objectContaining({ id: admitted.roundId, status: 'completed' }),
    ]);

    const blocked = await player.request('/gaming/rounds/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.40' },
      body: JSON.stringify({ gameId, currency: 'USD', betAmount: '10' }),
    });
    expect(blocked.status).toBe(409);
    expect(await readJson(blocked)).toMatchObject({
      code: 'CONFLICT',
      data: { reason: 'game_block', countryCode: 'US' },
    });
    expect(await getBalance()).toBe(balanceBeforeBlockedStart);
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
