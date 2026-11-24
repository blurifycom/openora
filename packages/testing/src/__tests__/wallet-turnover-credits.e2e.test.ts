import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions, moneyCompare } from '@openora/core/server';
import { JOB_QUEUE, WALLET_COMMANDS, queue, type WalletCreditArgs } from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { walletTransaction, walletTurnoverEntry } from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;
const commands = () => app.container.get(WALLET_COMMANDS);

type Entry = {
  source: string;
  currency: string;
  amount: string;
  pivotValue: string | null;
  required: string | null;
  status: string;
};

const expectMoney = (actual: unknown, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

const unratedCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

const player = (label: string) =>
  registerAndMaterializePlayer(app, { email: `turnover-${label}-${randomUUID()}@e2e.test` });

async function entriesOf(client: TestClient): Promise<Entry[]> {
  const res = await client.get('/wallet/turnover/entries');
  expect(res.status).toBe(200);
  return ((await readJson(res)) as { items: Entry[] }).items;
}

async function summaryOf(client: TestClient) {
  const res = await client.get('/wallet/turnover');
  expect(res.status).toBe(200);
  return readJson(res);
}

async function balanceOf(client: TestClient, currency: string) {
  const { balances } = (await readJson(await client.get('/wallet/balances'))) as {
    balances: { currency: string; balance: string }[];
  };
  return balances.find((b) => b.currency === currency)?.balance ?? '0';
}

const rate = (baseCurrency: string, value: string) =>
  drizzle()
    .insert(exchangeRateQuote)
    .values({ baseCurrency, quoteCurrency: 'USD', rate: value, providerAsOf: new Date() });

const transferCredit = (args: Partial<WalletCreditArgs> & Pick<WalletCreditArgs, 'userId'>) =>
  drizzle().transaction((tx) =>
    commands().credit(tx, {
      amount: '10',
      currency: 'USD',
      type: 'gift',
      allowNewWallet: true,
      providerRef: { providerName: 'chat', providerRefId: randomUUID() },
      ...args,
    }),
  );

const withdrawUsd = (client: TestClient) =>
  client.post('/wallet/withdraw', { amount: '1', currency: 'USD', idempotencyKey: randomUUID() });

const priceNow = () => app.container.get(JOB_QUEUE).enqueue(queue('wallet-turnover-pricing'), {});

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-wallet-turnover-credits-config',
        path: fixture('./fixtures/test-wallet-turnover-credits-config-plugin.ts'),
      },
      { id: 'testing-swap-desk', path: fixture('../test-swap-desk-plugin.ts') },
    ],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('a transfer credit in cash mode', () => {
  it.each(['gift', 'rain', 'donation'] as const)(
    'credits a %s as cash with one entry, and its replay moves nothing',
    async (type) => {
      const { client, userId } = await player(type);
      const providerRef = { providerName: 'chat', providerRefId: randomUUID() };

      const first = await transferCredit({ userId, type, providerRef, amount: '25' });
      const replay = await transferCredit({ userId, type, providerRef, amount: '25' });

      expect(first).toMatchObject({ ok: true, moved: true, transactionId: expect.any(String) });
      const transactionId = first.ok && first.moved ? first.transactionId : '';
      expect(replay).toMatchObject({
        ok: true,
        moved: false,
        replayedTransactionId: transactionId,
      });
      expectMoney(await balanceOf(client, 'USD'), '25', 'balance');
      const [row] = await drizzle()
        .select()
        .from(walletTransaction)
        .where(eq(walletTransaction.id, transactionId));
      expect(row).toMatchObject({ type, direction: 'credit', status: 'completed' });
      const entries = await entriesOf(client);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ source: type, currency: 'USD', status: 'counted' });
      expectMoney(entries[0]?.required, '25', 'required');
      expect(
        await drizzle().select().from(promoGrant).where(eq(promoGrant.userId, userId)),
      ).toEqual([]);
    },
  );

  it('credits a donation sharing its providerRef with the sender’s debit', async () => {
    const sender = await player('sender');
    const recipient = await player('recipient');
    const admin = await asAdmin(app.app);
    const funded = await admin.post('/wallet/manual-adjustments', {
      userId: sender.userId,
      direction: 'credit',
      amount: '50',
      currency: 'USD',
      reason: 'donation test funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const providerRef = { providerName: 'chat', providerRefId: randomUUID() };

    const credited = await drizzle().transaction(async (tx) => {
      const debited = await commands().debit(tx, {
        userId: sender.userId,
        amount: '20',
        currency: 'USD',
        type: 'donation',
        providerRef,
      });
      expect(debited.ok).toBe(true);
      return commands().credit(tx, {
        userId: recipient.userId,
        amount: '20',
        currency: 'USD',
        type: 'donation',
        allowNewWallet: true,
        providerRef,
      });
    });

    expect(credited).toMatchObject({ ok: true, moved: true });
    expectMoney(await balanceOf(sender.client, 'USD'), '30', 'sender balance');
    expectMoney(await balanceOf(recipient.client, 'USD'), '20', 'recipient balance');
    expect(await entriesOf(recipient.client)).toHaveLength(1);
    expect(await entriesOf(sender.client)).toEqual([]);
  });

  it('refuses a cash transfer credit without a providerRef', async () => {
    const { client, userId } = await player('no-ref');

    await expect(
      drizzle().transaction((tx) =>
        commands().credit(tx, {
          userId,
          amount: '10',
          currency: 'USD',
          type: 'gift',
          allowNewWallet: true,
        }),
      ),
    ).rejects.toMatchObject({ name: 'WalletBonusSourceRefRequiredError' });
    expectMoney(await balanceOf(client, 'USD'), '0', 'balance');
  });
});

describe('a swap', () => {
  it('adds a swap_in entry for what it bought', async () => {
    const { client, userId } = await player('swap');
    await rate('USDT', '1').onConflictDoNothing();
    await rate('BTC', '50000').onConflictDoNothing();
    const admin = await asAdmin(app.app);
    const funded = await admin.post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '0.02',
      currency: 'BTC',
      reason: 'swap test funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const quote = await readJson(
      await client.post('/wallet/swap/quote', {
        fromCurrency: 'BTC',
        toCurrency: 'USDT',
        fromAmount: '0.01',
      }),
    );

    const filled = await client.post('/wallet/swap', {
      fromCurrency: 'BTC',
      toCurrency: 'USDT',
      fromAmount: '0.01',
      quoteId: quote['quoteId'],
      idempotencyKey: randomUUID(),
    });

    expect(filled.status).toBe(200);
    const entries = await entriesOf(client);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'swap_in', currency: 'USDT', status: 'counted' });
    expectMoney(entries[0]?.amount, '500', 'amount');
  });
});

describe('an unpriced credit', () => {
  it('stays pending and locked until the pricing job prices it, once', async () => {
    const { client, userId } = await player('pending');
    const funded = await (
      await asAdmin(app.app)
    ).post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '5',
      currency: 'USD',
      reason: 'turnover pricing test funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const currency = unratedCurrency();
    await transferCredit({ userId, currency, amount: '10', allowNewCurrency: true });

    expect(await summaryOf(client)).toMatchObject({ pendingCount: 1, locked: true });
    expect(await entriesOf(client)).toMatchObject([{ status: 'pending', required: null }]);

    await rate(currency, '3');
    await Promise.all([priceNow(), priceNow()]);
    await vi.waitFor(
      async () => expect(await entriesOf(client)).toMatchObject([{ status: 'counted' }]),
      { timeout: 20_000, interval: 100 },
    );
    const refused = await withdrawUsd(client);
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      data: { reason: 'turnover_requirement_unmet', pending: false },
    });

    const summary = await summaryOf(client);
    expect(summary).toMatchObject({ pendingCount: 0, locked: true });
    expectMoney(summary.required, '30', 'required');
    const [entry] = await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(and(eq(walletTurnoverEntry.userId, userId), eq(walletTurnoverEntry.source, 'gift')));
    expectMoney(entry?.pivotValue, '30', 'pivotValue');
  });
});
