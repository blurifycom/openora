import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { user } from '@openora/core/pam/schema/identity';
import {
  OnRampCheckoutSchema,
  OnRampOrderSchema,
  OnRampOptionsSchema,
  SwapQuoteSchema,
  SwapResultSchema,
} from '@openora/core/wallet/contract';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { registerAndMaterializePlayer } from '../index.js';
import { signTestOnRampWebhook, TEST_ON_RAMP_SIGNATURE_HEADER } from '../test-on-ramp-plugin.js';
import {
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  newDepositScenario,
  type DepositScenario,
  type WalletE2e,
} from './support/wallet.js';
import {
  SWAP_VENDOR_RATE,
  SWAP_VENDOR_SIGNATURE_HEADER,
  SWAP_VENDOR_UNSUPPORTED_CURRENCY,
  signSwapWebhook,
} from './support/test-swap-vendor-plugin.js';

const plugin = (id: string, file: string) => ({
  id,
  path: fileURLToPath(new URL(file, import.meta.url)),
});

let e2e: WalletE2e;
let bare: WalletE2e;

const GEO_BLOCKED_IP = '203.0.113.30';
const GEO_BLOCKED_COUNTRY = 'TR';
const ON_RAMP_CURRENCY = 'USDT';
const ON_RAMP_NETWORK = 'TRC20';

beforeAll(async () => {
  e2e = await bootWalletE2e([
    plugin('testing-swap-vendor', './support/test-swap-vendor-plugin.ts'),
    plugin('testing-on-ramp', '../test-on-ramp-plugin.ts'),
    plugin('testing-geo-ip', '../test-geo-ip-plugin.ts'),
  ]);
  bare = await bootWalletE2e();
  const created = await e2e.admin.post('/wallet/admin/assets', {
    currency: ON_RAMP_CURRENCY,
    network: ON_RAMP_NETWORK,
    minDeposit: '1',
    providerAssetId: `${ON_RAMP_CURRENCY}-${ON_RAMP_NETWORK}`,
    minWithdrawal: '1',
    withdrawalFee: '0',
  });
  if (created.status !== 200 && created.status !== 409) {
    throw new Error(`on-ramp asset failed (${created.status}): ${await created.text()}`);
  }
  await e2e.app.container.get(DRIZZLE).db.insert(exchangeRateQuote).values({
    baseCurrency: ON_RAMP_CURRENCY,
    quoteCurrency: 'USD',
    rate: '1',
    providerAsOf: new Date(),
  });
}, 120_000);

afterAll(async () => {
  await closeWalletE2e(e2e);
  await closeWalletE2e(bare);
});

const money = (whole: string) => `${whole}.000000000000000000`;

const db = () => e2e.app.container.get(DRIZZLE).db;

const fundedScenario = async (amount = '10') => {
  const scenario = await newDepositScenario(e2e, { minDeposit: '1' });
  const res = await deliverWebhook(e2e, scenario.deposit({ amount }));
  expect(res.status).toBe(200);
  await expect.poll(() => balanceOf(e2e, scenario.userId, scenario.currency)).toBe(money(amount));
  return scenario;
};

const targetCurrency = async () => (await newDepositScenario(e2e, { minDeposit: '1' })).currency;

const swapBody = (from: DepositScenario, toCurrency: string, fromAmount: string) => ({
  fromCurrency: from.currency,
  toCurrency,
  fromAmount,
  idempotencyKey: randomUUID(),
});

const swapLegs = async (userId: string, currency: string) => {
  const [owned] = await db()
    .select({ id: wallet.id })
    .from(wallet)
    .where(eq(wallet.userId, userId));
  return db()
    .select()
    .from(walletTransaction)
    .where(
      and(
        eq(walletTransaction.walletId, owned?.id ?? ''),
        eq(walletTransaction.currency, currency),
      ),
    );
};

describe('player swap', () => {
  it('a player requesting a swap quote gets the rate and amounts for a supported pair', async () => {
    const from = await fundedScenario();
    const to = await targetCurrency();

    const res = await from.client.post('/wallet/swap/quote', {
      fromCurrency: from.currency,
      toCurrency: to,
      fromAmount: '4',
    });

    expect(res.status).toBe(200);
    expect(SwapQuoteSchema.parse(await res.json())).toMatchObject({
      fromCurrency: from.currency,
      toCurrency: to,
      fromAmount: '4',
      toAmount: money('8'),
      rate: SWAP_VENDOR_RATE,
    });
  });

  it('a player executing a swap moves both balances with one ledger row per leg and applies once on a repeated request', async () => {
    const from = await fundedScenario();
    const to = await targetCurrency();
    const body = swapBody(from, to, '4');

    const first = await from.client.post('/wallet/swap', body);
    expect(first.status).toBe(200);
    const result = SwapResultSchema.parse(await first.json());
    expect(result).toMatchObject({ status: 'completed', toAmount: money('8') });

    const again = await from.client.post('/wallet/swap', body);
    expect(again.status).toBe(200);
    expect(SwapResultSchema.parse(await again.json()).transactionId).toBe(result.transactionId);

    expect(await balanceOf(e2e, from.userId, from.currency)).toBe(money('6'));
    expect(await balanceOf(e2e, from.userId, to)).toBe(money('8'));
    const outLegs = (await swapLegs(from.userId, from.currency)).filter(
      (row) => row.type === 'swap_out',
    );
    const inLegs = (await swapLegs(from.userId, to)).filter((row) => row.type === 'swap_in');
    expect(outLegs).toHaveLength(1);
    expect(inLegs).toHaveLength(1);
    expect(outLegs[0]).toMatchObject({ amount: money('4'), status: 'completed' });
    expect(inLegs[0]).toMatchObject({ amount: money('8') });
  });

  it('a swap for an unsupported pair is refused and balances are unchanged', async () => {
    const from = await fundedScenario();

    const sameCurrency = await from.client.post('/wallet/swap', swapBody(from, from.currency, '4'));
    const vendorRefuses = await from.client.post(
      '/wallet/swap',
      swapBody(from, SWAP_VENDOR_UNSUPPORTED_CURRENCY, '4'),
    );

    expect(sameCurrency.status).toBe(409);
    expect(vendorRefuses.status).toBe(409);
    expect(await balanceOf(e2e, from.userId, from.currency)).toBe(money('10'));
    expect(await swapLegs(from.userId, from.currency)).toHaveLength(1);
  });

  it('a swap larger than the balance is refused and balances are unchanged', async () => {
    const from = await fundedScenario();
    const to = await targetCurrency();

    const res = await from.client.post('/wallet/swap', swapBody(from, to, '10.5'));

    expect(res.status).toBe(400);
    expect(await balanceOf(e2e, from.userId, from.currency)).toBe(money('10'));
    expect(await balanceOf(e2e, from.userId, to)).toBe('0');
    expect((await swapLegs(from.userId, from.currency)).map((row) => row.type)).toEqual([
      'deposit',
    ]);
  });

  it('a swap when no swap desk is available is refused as unavailable', async () => {
    const from = await newDepositScenario(bare, { minDeposit: '1' });
    const to = await newDepositScenario(bare, { minDeposit: '1' });

    const quote = await from.client.post('/wallet/swap/quote', {
      fromCurrency: from.currency,
      toCurrency: to.currency,
      fromAmount: '1',
    });
    const execute = await from.client.post('/wallet/swap', swapBody(from, to.currency, '1'));

    expect(quote.status).toBe(409);
    expect(execute.status).toBe(409);
  });

  it('a swap webhook with an invalid signature is rejected and changes nothing', async () => {
    const from = await fundedScenario('5');
    const to = await targetCurrency();
    const started = await from.client.post('/wallet/swap', swapBody(from, to, '3'));
    expect(started.status).toBe(200);
    const pending = SwapResultSchema.parse(await started.json());
    expect(pending).toMatchObject({ status: 'processing', toAmount: null });
    const rawBody = JSON.stringify({
      kind: 'swap',
      externalId: pending.transactionId,
      status: 'completed',
      toAmount: '6',
    });
    const post = (signature: string) =>
      e2e.app.app.request('/wallet/swap/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SWAP_VENDOR_SIGNATURE_HEADER]: signature },
        body: rawBody,
      });

    const forged = await post('0'.repeat(64));
    const unsigned = await e2e.app.app.request('/wallet/swap/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });

    expect(forged.status).toBe(401);
    expect(unsigned.status).toBe(401);
    expect(await balanceOf(e2e, from.userId, to)).toBe('0');
    expect(await balanceOf(e2e, from.userId, from.currency)).toBe(money('2'));
    const [outLeg] = await db()
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, pending.transactionId));
    expect(outLeg?.status).toBe('processing');

    const genuine = await post(signSwapWebhook(rawBody));
    expect(genuine.status).toBe(200);
    await expect.poll(() => balanceOf(e2e, from.userId, to)).toBe(money('6'));
  });

  it('an unauthenticated caller requesting a swap is refused with 401', async () => {
    const res = await e2e.app.app.request('/wallet/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromCurrency: 'AAA',
        toCurrency: 'BBB',
        fromAmount: '1',
        idempotencyKey: randomUUID(),
      }),
    });

    expect(res.status).toBe(401);
  });
});

describe('player on-ramp purchase', () => {
  const quoteBody = {
    fiatCurrency: 'EUR',
    fiatAmount: '100',
    currency: ON_RAMP_CURRENCY,
    network: ON_RAMP_NETWORK,
  };
  const checkoutBody = () => ({ ...quoteBody, idempotencyKey: randomUUID(), acknowledged: true });
  const newPlayer = () =>
    registerAndMaterializePlayer(e2e.app, { email: `on-ramp-${randomUUID()}@e2e.test` });

  it('a player reading on-ramp options and quote gets the available providers and the priced quote', async () => {
    const { client } = await newPlayer();

    const options = await client.get('/wallet/on-ramp/options');
    const quote = await client.post('/wallet/on-ramp/quote', quoteBody);

    expect(options.status).toBe(200);
    expect(OnRampOptionsSchema.parse(await options.json())).toEqual({
      fiats: [{ code: 'EUR', minAmount: '20', maxAmount: '5000' }],
      assets: [{ currency: ON_RAMP_CURRENCY, network: ON_RAMP_NETWORK }],
    });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toEqual([
      expect.objectContaining({
        gatewayId: 'test-gateway',
        fiatAmount: '100',
        cryptoAmount: money('50'),
        rate: '0.5',
      }),
    ]);
  });

  it('a player starting an on-ramp checkout gets an order they can read back', async () => {
    const { client } = await newPlayer();
    const body = checkoutBody();

    const res = await client.post('/wallet/on-ramp/checkout', body);
    expect(res.status).toBe(200);
    const checkout = OnRampCheckoutSchema.parse(await res.json());
    const replay = await client.post('/wallet/on-ramp/checkout', body);
    const order = await client.get(`/wallet/on-ramp/orders/${checkout.purchaseId}`);

    expect(OnRampCheckoutSchema.parse(await replay.json())).toEqual(checkout);
    expect(order.status).toBe(200);
    expect(OnRampOrderSchema.parse(await order.json())).toEqual({
      purchaseId: checkout.purchaseId,
      status: 'pending',
      fiatAmount: money('100'),
      fiatCurrency: 'EUR',
      currency: ON_RAMP_CURRENCY,
      network: ON_RAMP_NETWORK,
    });
  });

  it("a player reading another player's on-ramp order is refused as not found", async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    const created = await owner.client.post('/wallet/on-ramp/checkout', checkoutBody());
    const { purchaseId } = OnRampCheckoutSchema.parse(await created.json());

    const stolen = await other.client.get(`/wallet/on-ramp/orders/${purchaseId}`);
    const own = await owner.client.get(`/wallet/on-ramp/orders/${purchaseId}`);

    expect(stolen.status).toBe(404);
    expect(own.status).toBe(200);
  });

  it('an on-ramp checkout from a restricted player is refused', async () => {
    const { client, userId } = await newPlayer();
    await db().update(user).set({ rgBlocked: true }).where(eq(user.id, userId));

    const checkout = await client.post('/wallet/on-ramp/checkout', checkoutBody());
    const options = await client.get('/wallet/on-ramp/options');

    expect(checkout.status).toBe(403);
    expect(options.status).toBe(403);
  });

  it('an on-ramp checkout from a geo-blocked location is refused', async () => {
    const { client } = await newPlayer();
    const rule = {
      countryCode: GEO_BLOCKED_COUNTRY,
      redirectIp: false,
      kycRequired: true,
      confirm: true,
    };
    const blocked = await e2e.admin.put('/compliance/country-rules', {
      ...rule,
      blacklisted: true,
      expectedUpdatedAt: null,
    });
    expect(blocked.status).toBe(200);
    const stored = (await blocked.json()) as { updatedAt: string | null };
    try {
      const fromBlocked = await client.request('/wallet/on-ramp/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': GEO_BLOCKED_IP },
        body: JSON.stringify(checkoutBody()),
      });
      const fromAllowed = await client.request('/wallet/on-ramp/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.20' },
        body: JSON.stringify(checkoutBody()),
      });

      expect(fromBlocked.status).toBe(403);
      expect(fromAllowed.status).toBe(200);
    } finally {
      await e2e.admin.put('/compliance/country-rules', {
        ...rule,
        blacklisted: false,
        expectedUpdatedAt: stored.updatedAt,
      });
    }
  });

  it('an on-ramp checkout when no provider is available is refused as unavailable', async () => {
    const { client } = await registerAndMaterializePlayer(bare.app, {
      email: `on-ramp-${randomUUID()}@e2e.test`,
    });

    const res = await client.post('/wallet/on-ramp/checkout', checkoutBody());

    expect(res.status).toBe(409);
  });

  it.todo(
    'an on-ramp completion webhook credits the balance once and a repeated webhook changes nothing',
  );

  it('an on-ramp webhook with an invalid signature is rejected and credits nothing', async () => {
    const { client, userId } = await newPlayer();
    const created = await client.post('/wallet/on-ramp/checkout', checkoutBody());
    const { purchaseId } = OnRampCheckoutSchema.parse(await created.json());
    const rawBody = JSON.stringify({
      purchaseId,
      externalId: purchaseId,
      status: 'completed',
      txHash: `hash-${randomUUID()}`,
    });
    const post = (headers: Record<string, string>) =>
      e2e.app.app.request('/wallet/on-ramp/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: rawBody,
      });

    const forged = await post({ [TEST_ON_RAMP_SIGNATURE_HEADER]: '0'.repeat(64) });
    const unsigned = await post({});

    expect(forged.status).toBe(401);
    expect(unsigned.status).toBe(401);
    const order = await client.get(`/wallet/on-ramp/orders/${purchaseId}`);
    expect(OnRampOrderSchema.parse(await order.json()).status).toBe('pending');
    expect(await balanceOf(e2e, userId, ON_RAMP_CURRENCY)).toBe('0');

    const genuine = await post({ [TEST_ON_RAMP_SIGNATURE_HEADER]: signTestOnRampWebhook(rawBody) });
    expect(genuine.status).toBe(200);
    expect(await balanceOf(e2e, userId, ON_RAMP_CURRENCY)).toBe('0');
  });
});
