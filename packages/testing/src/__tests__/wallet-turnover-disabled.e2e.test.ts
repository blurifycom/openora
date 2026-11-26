import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { TurnoverDisabledError, WALLET_COMMANDS } from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { walletTurnover, walletTurnoverEntry } from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestDb,
} from '../index.js';
import { scheduledIds, waitForSchedule } from './support/job-schedules.js';

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;
const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-wallet-turnover-off-config',
        path: fixture('./support/test-wallet-turnover-off-config-plugin.ts'),
      },
      { id: 'testing-swap-desk', path: fixture('../test-swap-desk-plugin.ts') },
    ],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

it('schedules no pricing job while the multiplier is 0', async () => {
  await waitForSchedule(app.redisUrl, 'wallet-ledger-invariant', 'wallet-ledger-invariant.cron');
  expect(await scheduledIds(app.redisUrl, 'wallet-turnover-pricing')).toEqual([]);
});

it('reads as off with zeros and writes nothing while the multiplier is 0', async () => {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `turnover-off-${randomUUID()}@e2e.test`,
  });
  const deposit = await client.post('/wallet/deposit', {
    amount: '50',
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  expect(deposit.status).toBe(200);

  const summary = await client.get('/wallet/turnover');
  expect(summary.status).toBe(200);
  expect(await readJson(summary)).toEqual({
    enabled: false,
    pivotCurrency: 'USD',
    required: '0',
    progress: '0',
    remaining: '0',
    dustThreshold: '0.01',
    locked: false,
    pendingCount: 0,
    updatedAt: null,
  });
  const entries = await client.get('/wallet/turnover/entries');
  expect(await readJson(entries)).toEqual({ items: [], nextCursor: null });

  await expect(
    drizzle().transaction(async (tx) => {
      const commands = app.container.get(WALLET_COMMANDS);
      if (!commands.addTurnoverRequirement) {
        throw new Error('addTurnoverRequirement is not bound');
      }
      return commands.addTurnoverRequirement(tx, {
        userId,
        currency: 'USD',
        requiredInCurrency: '10',
        source: 'grant_conversion',
        sourceRef: randomUUID(),
      });
    }),
  ).rejects.toBeInstanceOf(TurnoverDisabledError);

  expect(
    await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
  ).toEqual([]);
  expect(
    await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, userId)),
  ).toEqual([]);
});

it('adds no turnover row for a cash gift or a swap while the multiplier is 0', async () => {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `turnover-off-credits-${randomUUID()}@e2e.test`,
  });
  const gifted = await drizzle().transaction((tx) =>
    app.container.get(WALLET_COMMANDS).credit(tx, {
      userId,
      amount: '10',
      currency: 'USD',
      type: 'gift',
      allowNewWallet: true,
      providerRef: { providerName: 'chat', providerRefId: randomUUID() },
    }),
  );
  expect(gifted).toMatchObject({ ok: true, moved: true });

  for (const [baseCurrency, rate] of [
    ['BTC', '50000'],
    ['USDT', '1'],
  ] as const) {
    await drizzle()
      .insert(exchangeRateQuote)
      .values({ baseCurrency, quoteCurrency: 'USD', rate, providerAsOf: new Date() })
      .onConflictDoNothing();
  }
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

  expect(
    await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
  ).toEqual([]);
  expect(
    await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, userId)),
  ).toEqual([]);
});
