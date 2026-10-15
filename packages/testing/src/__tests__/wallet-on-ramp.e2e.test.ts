import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { walletDepositAddress } from '@openora/core/wallet/schema';
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
import {
  setTestOnRampStatus,
  signTestOnRampWebhook,
  TEST_ON_RAMP_SIGNATURE_HEADER,
} from '../test-on-ramp-plugin.js';

const onRampPluginPath = fileURLToPath(new URL('../test-on-ramp-plugin.ts', import.meta.url));

const PURCHASE = { fiatCurrency: 'EUR', fiatAmount: '100', currency: 'USDT', network: 'TRC20' };

let db: TestDb;
let testApp: TestApp;

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (body === null || typeof body !== 'object') {
    throw new Error('expected JSON object');
  }
  return body as Record<string, unknown>;
}

// The default payment adapter issues no deposit addresses, so each player gets one up front,
// as a custody rail would have issued it.
async function player(): Promise<TestClient> {
  const { client, userId } = await registerAndMaterializePlayer(testApp, {
    email: `on-ramp-${randomUUID()}@e2e.test`,
  });
  await testApp.container
    .get(DRIZZLE)
    .db.insert(walletDepositAddress)
    .values({
      userId,
      currency: PURCHASE.currency,
      network: PURCHASE.network,
      address: `T-${userId}`,
      providerName: DEFAULT_PAYMENT_PROVIDER,
    });
  return client;
}

async function checkout(client: TestClient) {
  const res = await client.post('/wallet/on-ramp/checkout', {
    ...PURCHASE,
    idempotencyKey: randomUUID(),
    acknowledged: true,
  });
  expect(res.status).toBe(200);
  return json(res);
}

const externalIdOf = (checkoutUrl: unknown) => String(checkoutUrl).split('/').at(-1) ?? '';

const deliverWebhook = (body: object, signature: string) => {
  const rawBody = JSON.stringify(body);
  return testApp.app.request('/wallet/on-ramp/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TEST_ON_RAMP_SIGNATURE_HEADER]:
        signature === 'valid' ? signTestOnRampWebhook(rawBody) : signature,
    },
    body: rawBody,
  });
};

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({
    plugins: [...(await loadExtensions()), { id: 'testing-on-ramp', path: onRampPluginPath }],
    databaseUrl: db.url,
  });
  await seedMinimal(testApp.container, { playerCount: 0 });
  const admin = await asAdmin(testApp.app);
  const asset = await admin.post('/wallet/admin/assets', {
    currency: 'USDT',
    network: 'TRC20',
    providerAssetId: 'usdt-trc20',
    minDeposit: '1',
    minWithdrawal: '1',
    withdrawalFee: '0',
  });
  expect(asset.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('GET /wallet/on-ramp/options', () => {
  it("lists the vendor's fiats and the assets the platform takes deposits in", async () => {
    const res = await (await player()).get('/wallet/on-ramp/options');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      fiats: [{ code: 'EUR', minAmount: '20', maxAmount: '5000' }],
      assets: [{ currency: 'USDT', network: 'TRC20' }],
    });
  });
});

describe('POST /wallet/on-ramp/quote', () => {
  it('prices a purchase and refuses one under the vendor minimum with a reason', async () => {
    const client = await player();
    const quoted = await client.post('/wallet/on-ramp/quote', PURCHASE);
    expect(quoted.status).toBe(200);
    expect(await quoted.json()).toMatchObject([
      { fiatAmount: '100', cryptoAmount: '50.000000000000000000' },
    ]);

    const refused = await client.post('/wallet/on-ramp/quote', { ...PURCHASE, fiatAmount: '10' });
    expect(refused.status).toBe(400);
    expect((await json(refused))['data']).toEqual({
      reason: 'below_minimum',
      fiatCurrency: 'EUR',
      minAmount: '20',
    });
  });
});

describe('POST /wallet/on-ramp/checkout', () => {
  it('opens an https checkout, replays it for the same key, refuses the key for another amount', async () => {
    const client = await player();
    const input = { ...PURCHASE, idempotencyKey: randomUUID(), acknowledged: true };

    const opened = await client.post('/wallet/on-ramp/checkout', input);
    expect(opened.status).toBe(200);
    const first = await json(opened);
    expect(first['checkoutUrl']).toMatch(/^https:\/\//);

    const replayed = await client.post('/wallet/on-ramp/checkout', input);
    expect(await json(replayed)).toEqual(first);

    const reused = await client.post('/wallet/on-ramp/checkout', { ...input, fiatAmount: '200' });
    expect(reused.status).toBe(409);
  });

  it('refuses a checkout the player did not acknowledge', async () => {
    const res = await (
      await player()
    ).post('/wallet/on-ramp/checkout', {
      ...PURCHASE,
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /wallet/on-ramp/orders/{purchaseId}', () => {
  it("answers the owner the vendor's status and another player NOT_FOUND", async () => {
    const owner = await player();
    const { purchaseId, checkoutUrl } = await checkout(owner);
    setTestOnRampStatus(externalIdOf(checkoutUrl), 'processing');

    const own = await owner.get(`/wallet/on-ramp/orders/${String(purchaseId)}`);
    expect(own.status).toBe(200);
    expect(await json(own)).toMatchObject({ purchaseId, status: 'processing' });

    const other = await (await player()).get(`/wallet/on-ramp/orders/${String(purchaseId)}`);
    expect(other.status).toBe(404);
  });
});

describe('POST /wallet/on-ramp/webhook', () => {
  it('moves a signed status update onto the order and rejects a bad signature with 401', async () => {
    const client = await player();
    const { purchaseId, checkoutUrl } = await checkout(client);
    const event = { purchaseId, externalId: externalIdOf(checkoutUrl), status: 'cancelled' };

    const forged = await deliverWebhook(event, 'forged');
    expect(forged.status).toBe(401);

    const signed = await deliverWebhook(event, 'valid');
    expect(signed.status).toBe(200);
    expect(await json(signed)).toEqual({ ok: true });

    const order = await client.get(`/wallet/on-ramp/orders/${String(purchaseId)}`);
    expect(await json(order)).toMatchObject({ purchaseId, status: 'cancelled' });
  });
});
