import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestDb,
} from '../index.js';

let db: TestDb;
let testApp: TestApp;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error('expected JSON object');
  }
  return Object.fromEntries(Object.entries(value));
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('withdrawal queue summary', () => {
  it('counts and totals queued withdrawals per currency, and refuses a player', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const { client: player } = await registerAndMaterializePlayer(testApp, {
      email: `withdrawal-summary-${randomUUID()}@e2e.test`,
    });
    const admin = await asAdmin(testApp.app);

    for (const [currency, deposit, withdrawals] of [
      ['USD', '10', ['2', '3']],
      ['EUR', '5', ['1']],
    ] as const) {
      await player.post('/wallet/deposit', {
        idempotencyKey: randomUUID(),
        amount: deposit,
        currency,
      });
      for (const amount of withdrawals) {
        const res = await player.post('/wallet/withdraw', {
          idempotencyKey: randomUUID(),
          amount,
          currency,
        });
        expect(res.status).toBe(200);
      }
    }

    const denied = await player.get(`/wallet/withdrawals/summary?dateFrom=${since}`);
    expect(denied.status).toBe(403);

    const all = object(
      await (await admin.get(`/wallet/withdrawals/summary?dateFrom=${since}`)).json(),
    );
    expect(all['pendingCount']).toBe(3);
    expect(all['onHoldCount']).toBe(0);
    expect(all['queuedTotals']).toEqual([
      { currency: 'EUR', amount: expect.stringMatching(/^1(\.0+)?$/) },
      { currency: 'USD', amount: expect.stringMatching(/^5(\.0+)?$/) },
    ]);
    expect(all['avgPendingWaitSeconds']).toEqual(expect.any(Number));

    const usdOnly = object(
      await (await admin.get(`/wallet/withdrawals/summary?dateFrom=${since}&currency=USD`)).json(),
    );
    expect(usdOnly['pendingCount']).toBe(2);
    expect(usdOnly['queuedTotals']).toEqual([
      { currency: 'USD', amount: expect.stringMatching(/^5(\.0+)?$/) },
    ]);
  });
});
