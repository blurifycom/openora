import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions, moneyCompare } from '@openora/core/server';
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

async function fundedPlayer(btc: string): Promise<TestClient> {
  const { client, userId } = await registerAndMaterializePlayer(testApp, {
    email: `swap-refusal-${randomUUID()}@e2e.test`,
  });
  const admin = await asAdmin(testApp.app);
  const credited = await admin.post('/wallet/manual-adjustments', {
    userId,
    direction: 'credit',
    amount: btc,
    currency: 'BTC',
    reason: 'swap test funds',
    idempotencyKey: randomUUID(),
  });
  expect(credited.status).toBe(200);
  return client;
}

async function expectBalance(player: TestClient, currency: string, amount: string) {
  const { balances } = (await json(await player.get('/wallet/balances'))) as {
    balances: { currency: string; balance: string }[];
  };
  const balance = balances.find((b) => b.currency === currency)?.balance ?? '0';
  expect(moneyCompare(balance, amount), `${currency} balance ${balance}`).toBe(0);
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
  it('prices a crypto swap inside the desk limit', async () => {
    const player = await fundedPlayer('0.02');
    const res = await player.post('/wallet/swap/quote', {
      fromCurrency: 'BTC',
      toCurrency: 'USDT',
      fromAmount: '0.01',
    });
    expect(res.status).toBe(200);
    expect(moneyCompare(String((await json(res))['toAmount']), '500')).toBe(0);
  });

  it('answers a swap over the desk limit with 400 and a reason, not a 500', async () => {
    const player = await fundedPlayer('2');
    const res = await player.post('/wallet/swap/quote', {
      fromCurrency: 'BTC',
      toCurrency: 'USDT',
      fromAmount: '1.5',
    });
    expect(res.status).toBe(400);
    expect((await json(res))['data']).toEqual({ reason: 'over_swap_limit' });
  });
});

describe('POST /wallet/swap', () => {
  it('fills a quote, then answers its replay with 409 and returns the held BTC', async () => {
    const player = await fundedPlayer('0.02');
    const quote = await json(
      await player.post('/wallet/swap/quote', {
        fromCurrency: 'BTC',
        toCurrency: 'USDT',
        fromAmount: '0.01',
      }),
    );
    const swap = {
      fromCurrency: 'BTC',
      toCurrency: 'USDT',
      fromAmount: '0.01',
      quoteId: quote['quoteId'],
    };

    const filled = await player.post('/wallet/swap', { ...swap, idempotencyKey: randomUUID() });
    expect(filled.status).toBe(200);
    expect((await json(filled))['status']).toBe('completed');
    await expectBalance(player, 'BTC', '0.01');
    await expectBalance(player, 'USDT', '500');

    const replayed = await player.post('/wallet/swap', { ...swap, idempotencyKey: randomUUID() });
    expect(replayed.status).toBe(409);
    expect((await json(replayed))['data']).toEqual({ reason: 'quote_spent' });
    // The replay held 0.01 BTC before the desk refused it; it must come back, with no USDT paid.
    await expectBalance(player, 'BTC', '0.01');
    await expectBalance(player, 'USDT', '500');
  });
});
