import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
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
import { TEST_SWAP_DESK_LIMIT } from '../test-swap-desk-plugin.js';

const swapDeskPluginPath = fileURLToPath(new URL('../test-swap-desk-plugin.ts', import.meta.url));

let db: TestDb;
let testApp: TestApp;

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (body === null || typeof body !== 'object') {
    throw new Error('expected JSON object');
  }
  return body as Record<string, unknown>;
}

async function fundedPlayer(amount: string): Promise<TestClient> {
  const { client, userId } = await registerAndMaterializePlayer(testApp, {
    email: `swap-refusal-${randomUUID()}@e2e.test`,
  });
  const admin = await asAdmin(testApp.app);
  const credited = await admin.post('/wallet/manual-adjustments', {
    userId,
    direction: 'credit',
    amount,
    currency: 'USD',
    reason: 'swap test funds',
    idempotencyKey: randomUUID(),
  });
  expect(credited.status).toBe(200);
  return client;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({
    plugins: [...(await loadExtensions()), { id: 'testing-swap-desk', path: swapDeskPluginPath }],
    databaseUrl: db.url,
  });
  await seedMinimal(testApp.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('POST /wallet/swap/quote', () => {
  it('prices a swap inside the desk limit', async () => {
    const player = await fundedPlayer('10');
    const res = await player.post('/wallet/swap/quote', {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAmount: '5',
    });
    expect(res.status).toBe(200);
    expect((await json(res))['toAmount']).toBe('5');
  });

  it('answers a swap over the desk limit with 400 and a reason, not a 500', async () => {
    const player = await fundedPlayer('10');
    const res = await player.post('/wallet/swap/quote', {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAmount: String(TEST_SWAP_DESK_LIMIT + 1),
    });
    expect(res.status).toBe(400);
    expect((await json(res))['data']).toEqual({ reason: 'over_swap_limit' });
  });
});

describe('POST /wallet/swap', () => {
  it('fills a quote, then answers its replay with 409 and returns the held funds', async () => {
    const player = await fundedPlayer('10');
    const quote = await json(
      await player.post('/wallet/swap/quote', {
        fromCurrency: 'USD',
        toCurrency: 'EUR',
        fromAmount: '5',
      }),
    );
    const swap = {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAmount: '5',
      quoteId: quote['quoteId'],
    };

    const filled = await player.post('/wallet/swap', { ...swap, idempotencyKey: randomUUID() });
    expect(filled.status).toBe(200);
    expect((await json(filled))['status']).toBe('completed');

    const replayed = await player.post('/wallet/swap', { ...swap, idempotencyKey: randomUUID() });
    expect(replayed.status).toBe(409);
    expect((await json(replayed))['data']).toEqual({ reason: 'quote_spent' });

    const balance = await json(await player.get('/wallet/balance'));
    expect(balance['balance']).toBe('5.000000000000000000');
  });
});
