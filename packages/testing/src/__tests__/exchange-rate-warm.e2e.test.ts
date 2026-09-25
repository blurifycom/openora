import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { DEFAULT_CRYPTO_CURRENCIES, JOB_QUEUE, queue } from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { bootTestApp, setupTestDb, type TestApp, type TestDb } from '../index.js';
import { TEST_EXCHANGE_RATE } from '../test-exchange-rate-provider-plugin.js';

const rateProviderPluginPath = fileURLToPath(
  new URL('../test-exchange-rate-provider-plugin.ts', import.meta.url),
);

let db: TestDb;
let testApp: TestApp;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  testApp = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      { id: 'testing-exchange-rate-provider', path: rateProviderPluginPath },
    ],
    databaseUrl: db.url,
  });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

const storedRates = async () =>
  testApp.container
    .get(DRIZZLE)
    .db.select({ base: exchangeRateQuote.baseCurrency, rate: exchangeRateQuote.rate })
    .from(exchangeRateQuote);

describe('exchange rate warm-up job', () => {
  it('stores a rate for every configured crypto currency without any caller asking for one', async () => {
    await testApp.container.get(JOB_QUEUE).enqueue(queue('exchange-rate-warm'), {});

    await vi.waitFor(
      async () => {
        const rows = await storedRates();
        expect(rows.map((row) => row.base)).toEqual(
          expect.arrayContaining([...DEFAULT_CRYPTO_CURRENCIES]),
        );
        expect(rows.every((row) => row.rate === TEST_EXCHANGE_RATE)).toBe(true);
      },
      { timeout: 10_000 },
    );
  });
});
