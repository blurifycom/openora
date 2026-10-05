import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
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

// A BTC deposit snapshots its reference value, which needs a BTC rate.
const exchangeRatePluginPath = fileURLToPath(
  new URL('../test-exchange-rate-provider-plugin.ts', import.meta.url),
);

let db: TestDb;
let testApp: TestApp;

type QueuePage = { total: number; items: { transactionId: string; userId: string }[] };

function isQueuePage(value: unknown): value is QueuePage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'total' in value &&
    typeof value.total === 'number' &&
    'items' in value &&
    Array.isArray(value.items)
  );
}

async function searchQueue(admin: TestClient, search: string, extra = ''): Promise<QueuePage> {
  const res = await admin.get(`/wallet/withdrawals?search=${encodeURIComponent(search)}${extra}`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (!isQueuePage(body)) {
    throw new Error('expected a withdrawal queue page');
  }
  return body;
}

async function withdraw(
  player: TestClient,
  input: { amount: string; currency: string; destinationAddress?: string },
): Promise<string> {
  const res = await player.post('/wallet/withdraw', { idempotencyKey: randomUUID(), ...input });
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (body === null || typeof body !== 'object' || !('transactionId' in body)) {
    throw new Error('expected a transaction result');
  }
  return String(body.transactionId);
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      { id: 'testing-exchange-rate-provider', path: exchangeRatePluginPath },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(testApp.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('withdrawal queue search', () => {
  it('matches a user id, an email fragment and a destination address, and refuses a player', async () => {
    const emailTag = `queue-search-${randomUUID()}`;
    const { client: searched, userId: searchedUserId } = await registerAndMaterializePlayer(
      testApp,
      { email: `${emailTag}@e2e.test` },
    );
    const { client: other } = await registerAndMaterializePlayer(testApp, {
      email: `queue-other-${randomUUID()}@e2e.test`,
    });
    const admin = await asAdmin(testApp.app);

    const evmAddress = `0xAbCdEf${randomBytes(17).toString('hex')}`;
    const caseSensitiveAddress = `bc1qSearch${randomBytes(12).toString('hex')}`;
    await searched.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '0.1',
      currency: 'BTC',
    });
    const evmWithdrawalId = await withdraw(searched, {
      amount: '0.01',
      currency: 'BTC',
      destinationAddress: evmAddress,
    });
    const caseSensitiveWithdrawalId = await withdraw(searched, {
      amount: '0.01',
      currency: 'BTC',
      destinationAddress: caseSensitiveAddress,
    });
    await other.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });
    await withdraw(other, { amount: '4', currency: 'USD' });

    const denied = await searched.get(`/wallet/withdrawals?search=${searchedUserId}`);
    expect(denied.status).toBe(403);

    const bothIds = [evmWithdrawalId, caseSensitiveWithdrawalId].sort();
    const byUserId = await searchQueue(admin, searchedUserId);
    expect(byUserId.total).toBe(2);
    expect(byUserId.items.map((item) => item.transactionId).sort()).toEqual(bothIds);

    const byEmailFragment = await searchQueue(admin, emailTag.toUpperCase());
    expect(byEmailFragment.total).toBe(2);
    expect(byEmailFragment.items.every((item) => item.userId === searchedUserId)).toBe(true);

    const byEvmAddress = await searchQueue(admin, evmAddress.toLowerCase());
    expect(byEvmAddress.items.map((item) => item.transactionId)).toEqual([evmWithdrawalId]);

    const byExactAddress = await searchQueue(admin, caseSensitiveAddress);
    expect(byExactAddress.items.map((item) => item.transactionId)).toEqual([
      caseSensitiveWithdrawalId,
    ]);
    expect((await searchQueue(admin, caseSensitiveAddress.toLowerCase())).total).toBe(0);
    expect((await searchQueue(admin, caseSensitiveAddress.slice(0, -1))).total).toBe(0);
  });

  it('combines with the other filters and narrows the summary to the same rows', async () => {
    const { client: player, userId } = await registerAndMaterializePlayer(testApp, {
      email: `queue-search-filters-${randomUUID()}@e2e.test`,
    });
    const admin = await asAdmin(testApp.app);
    await player.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });
    await withdraw(player, { amount: '2', currency: 'USD' });
    await withdraw(player, { amount: '3', currency: 'USD' });

    expect((await searchQueue(admin, userId, '&status=pending')).total).toBe(2);
    expect((await searchQueue(admin, userId, '&status=rejected')).total).toBe(0);
    expect((await searchQueue(admin, userId, '&minAmount=3')).total).toBe(1);
    const firstPage = await searchQueue(admin, userId, '&limit=1');
    expect(firstPage.total).toBe(2);
    expect(firstPage.items).toHaveLength(1);

    const summary: unknown = await (
      await admin.get(`/wallet/withdrawals/summary?search=${userId}`)
    ).json();
    expect(summary).toMatchObject({
      pendingCount: 2,
      queuedTotals: [{ currency: 'USD', amount: expect.stringMatching(/^5(\.0+)?$/) }],
    });
  });

  it('treats LIKE wildcards in the term as literal characters', async () => {
    const admin = await asAdmin(testApp.app);
    expect((await searchQueue(admin, '%')).total).toBe(0);
    expect((await searchQueue(admin, '_@_')).total).toBe(0);
  });
});
