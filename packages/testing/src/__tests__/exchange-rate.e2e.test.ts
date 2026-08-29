import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let player: TestClient;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  ({ client: player } = await registerAndMaterializePlayer(app, {
    email: `exchange-rate-${randomUUID()}@e2e.test`,
  }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('GET /exchange-rate/rate', () => {
  it('returns null when no rate has been refreshed for the pair yet (never calls a vendor)', async () => {
    const res = await player.get('/exchange-rate/rate?from=EUR&to=GBP');

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns the trivial 1:1 quote for identical currencies with no data at all', async () => {
    const res = await player.get('/exchange-rate/rate?from=USD&to=USD');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: string; asOf: string };
    expect(body.rate).toBe('1.000000000000000000');
    expect(typeof body.asOf).toBe('string');
  });

  it('rejects a malformed currency code with a validation error instead of 200', async () => {
    const res = await player.get('/exchange-rate/rate?from=eur&to=GBP');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
