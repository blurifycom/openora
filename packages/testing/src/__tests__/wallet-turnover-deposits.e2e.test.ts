import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, moneyCompare } from '@openora/core/server';
import { WALLET_COMMANDS, type WalletCreditArgs } from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { walletTurnover, walletTurnoverEntry } from '@openora/core/wallet/schema';
import { readJson, registerAndMaterializePlayer, type TestClient } from '../index.js';
import { allowDepositing, barFromDepositing } from './support/test-deposit-hold-plugin.js';
import {
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  findingsFor,
  newDepositScenario,
  type WalletE2e,
} from './support/wallet.js';

const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    {
      id: 'testing-wallet-turnover-deposits-config',
      path: fixture('./support/test-wallet-turnover-deposits-config-plugin.ts'),
    },
    { id: 'testing-swap-desk', path: fixture('../test-swap-desk-plugin.ts') },
  ]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const drizzle = () => e2e.app.container.get(DRIZZLE).db;
const setup = (options: { rated?: boolean } = {}) => newDepositScenario(e2e, options);
const deliver = (event: unknown) => deliverWebhook(e2e, event);
const findings = (externalId: string) => findingsFor(e2e, externalId);

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

async function ratedPlayer(rate: string) {
  const player = await setup({ rated: false });
  await drizzle().insert(exchangeRateQuote).values({
    baseCurrency: player.currency,
    quoteCurrency: 'USD',
    rate,
    providerAsOf: new Date(),
  });
  return player;
}

describe('a completed deposit', () => {
  it('adds one entry priced at the rate it was credited under, and a redelivery adds none', async () => {
    const player = await ratedPlayer('2');
    const event = player.deposit({ amount: '10' });

    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);

    const entries = await entriesOf(player.client);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      source: 'deposit',
      currency: player.currency,
      status: 'counted',
    });
    expectMoney(entry?.amount, '10', 'amount');
    expectMoney(entry?.pivotValue, '20', 'pivotValue');
    expectMoney(entry?.required, '20', 'required');

    await drizzle()
      .update(exchangeRateQuote)
      .set({ rate: '5', providerAsOf: new Date() })
      .where(eq(exchangeRateQuote.baseCurrency, player.currency));

    const [after] = await entriesOf(player.client);
    expectMoney(after?.pivotValue, '20', 'pivotValue after the rate moved');
    const summary = await summaryOf(player.client);
    expectMoney(summary.required, '20', 'summary required');
    expect(summary).toMatchObject({ locked: true, pendingCount: 0 });
  });

  it('adds nothing while held and exactly one entry once released', async () => {
    const player = await ratedPlayer('1');
    barFromDepositing(player.userId);
    const event = player.deposit({ amount: '10' });

    expect((await deliver(event)).status).toBe(200);
    expect(await entriesOf(player.client)).toEqual([]);
    expect(
      await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, player.userId)),
    ).toEqual([]);

    allowDepositing(player.userId);
    const [finding] = await findings(event.externalId);
    expect(finding).toBeDefined();
    const released = await e2e.admin.post(`/wallet/reconciliation/${finding!.id}/resolve`, {
      resolution: { outcome: 'released' },
    });
    expect(released.status).toBe(200);
    const entries = await entriesOf(player.client);
    expect(entries).toHaveLength(1);
    expectMoney(entries[0]?.required, '10', 'required');

    expect((await deliver(event)).status).toBe(200);
    expect(await entriesOf(player.client)).toHaveLength(1);
  });

  it('starts a new requirement from progress = required once the last one was met', async () => {
    const player = await ratedPlayer('2');
    expect((await deliver(player.deposit({ amount: '10' }))).status).toBe(200);
    const staked = await drizzle().transaction((tx) =>
      e2e.app.container.get(WALLET_COMMANDS).debit(tx, {
        userId: player.userId,
        amount: '9.996',
        currency: player.currency,
        type: 'bet',
        context: { provider: 'aggregator', product: 'casino' },
        providerRef: { providerName: 'aggregator', providerRefId: randomUUID() },
      }),
    );
    expect(staked).toMatchObject({ ok: true, moved: true });
    expect(await summaryOf(player.client)).toMatchObject({ locked: false });

    expect((await deliver(player.deposit({ amount: '10' }))).status).toBe(200);

    const summary = await summaryOf(player.client);
    expectMoney(summary.progress, '20', 'progress');
    expectMoney(summary.required, '40', 'required');
    expectMoney(summary.remaining, '20', 'remaining');
  });
});

describe('a donation in bonus_grant mode', () => {
  it('lands as a bonus grant and adds no entry, even with donation in creditTypes', async () => {
    const { client, userId } = await registerAndMaterializePlayer(e2e.app, {
      email: `turnover-grant-${randomUUID()}@e2e.test`,
    });
    const providerRefId = randomUUID();

    const outcome = await drizzle().transaction((tx) =>
      e2e.app.container.get(WALLET_COMMANDS).credit(tx, {
        userId,
        amount: '10',
        currency: 'USD',
        type: 'donation',
        allowNewWallet: true,
        providerRef: { providerName: 'chat', providerRefId },
      } satisfies WalletCreditArgs),
    );

    expect(outcome).toMatchObject({ ok: true, moved: false });
    const grants = await drizzle()
      .select()
      .from(promoGrant)
      .where(and(eq(promoGrant.userId, userId), eq(promoGrant.sourceRef, providerRefId)));
    expect(grants).toHaveLength(1);
    expect(await entriesOf(client)).toEqual([]);
    expect(
      await drizzle()
        .select()
        .from(walletTurnoverEntry)
        .where(eq(walletTurnoverEntry.userId, userId)),
    ).toEqual([]);
  });
});

describe('a credit kind not in creditTypes', () => {
  it('adds no entry for a swap while swap_in is not configured', async () => {
    const { client, userId } = await registerAndMaterializePlayer(e2e.app, {
      email: `turnover-swap-${randomUUID()}@e2e.test`,
    });
    for (const [baseCurrency, rate] of [
      ['BTC', '50000'],
      ['USDT', '1'],
    ] as const) {
      await drizzle()
        .insert(exchangeRateQuote)
        .values({ baseCurrency, quoteCurrency: 'USD', rate, providerAsOf: new Date() })
        .onConflictDoNothing();
    }
    const funded = await e2e.admin.post('/wallet/manual-adjustments', {
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
    expect(await entriesOf(client)).toEqual([]);
    expect(
      await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    ).toEqual([]);
  });
});
