import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import {
  FinancialSummarySchema,
  GgrSeriesSchema,
  ProductRevenueSchema,
} from '@openora/core/analytics/contract';
import { gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  newPlayer,
  newStaff,
  type E2e,
  type TestClient,
} from '../index.js';

let e2e: E2e;
let superAdmin: TestClient;
let playerClient: TestClient;
let noAnalyticsClient: TestClient;
let readOnlyClient: TestClient;
let walletId: string;

beforeAll(async () => {
  e2e = await bootE2e();
  superAdmin = await asAdmin(e2e.app.app);
  playerClient = (await newPlayer(e2e.app, 'analytics-player')).client;
  noAnalyticsClient = (await newStaff(e2e.app, 'analytics-none', 'customer-support-agent')).client;
  readOnlyClient = (await newStaff(e2e.app, 'analytics-readonly', 'finance-accounting')).client;
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.insert(wallet)
    .values({ userId: randomUUID() })
    .returning({ id: wallet.id });
  if (!row) {
    throw new Error('wallet row was not created');
  }
  walletId = row.id;
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const GgrSchema = z.array(GgrSeriesSchema);
const ProductsSchema = z.array(ProductRevenueSchema);

type TxType = (typeof walletTransaction.$inferInsert)['type'];
type TxStatus = NonNullable<(typeof walletTransaction.$inferInsert)['status']>;
type Rail = NonNullable<(typeof walletTransaction.$inferInsert)['rail']>;

let windowCounter = 0;
const nextWindow = () => {
  windowCounter += 1;
  const year = 2000 + windowCounter;
  return {
    dateFrom: `${year}-03-10T00:00:00.000Z`,
    dateTo: `${year}-03-12T23:59:59.999Z`,
    at: (day: number) => new Date(`${year}-03-${String(day).padStart(2, '0')}T12:00:00.000Z`),
  };
};

const uniqueCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

async function seedTx(input: {
  type: TxType;
  amount: string;
  currency: string;
  at: Date;
  status?: TxStatus;
  rail?: Rail;
}) {
  await db()
    .insert(walletTransaction)
    .values({
      walletId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      status: input.status ?? 'completed',
      rail: input.rail ?? null,
      createdAt: input.at,
    });
}

const query = (params: Record<string, unknown>) =>
  `?${new URLSearchParams(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ).toString()}`;

async function readSummary(client: TestClient, window: { dateFrom: string; dateTo: string }) {
  const res = await client.get(`/analytics/financial/summary${query(window)}`);
  expect(res.status).toBe(200);
  return FinancialSummarySchema.parse(await res.json());
}

const forCurrency = <T extends { currency: string }>(rows: readonly T[], currency: string) =>
  rows.filter((row) => row.currency === currency);

const scale18 = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(18, '0')}`;
};

describe('financial analytics reports', () => {
  it('an admin with analytics permission reads the summary and deposits and withdrawals appear per currency', async () => {
    const window = nextWindow();
    const usdLike = uniqueCurrency();
    const coinLike = uniqueCurrency();
    await seedTx({
      type: 'deposit',
      amount: '100.5',
      currency: usdLike,
      at: window.at(10),
      rail: 'crypto',
    });
    await seedTx({
      type: 'deposit',
      amount: '20',
      currency: usdLike,
      at: window.at(10),
      rail: 'fiat',
    });
    await seedTx({
      type: 'withdrawal',
      amount: '30.25',
      currency: usdLike,
      at: window.at(11),
      rail: 'crypto',
    });
    await seedTx({ type: 'bonus', amount: '5', currency: usdLike, at: window.at(11) });
    await seedTx({ type: 'bet', amount: '50', currency: usdLike, at: window.at(11) });
    await seedTx({ type: 'win', amount: '20', currency: usdLike, at: window.at(11) });
    await seedTx({ type: 'bet_reversal', amount: '4', currency: usdLike, at: window.at(12) });
    await seedTx({ type: 'win_reversal', amount: '1', currency: usdLike, at: window.at(12) });
    await seedTx({
      type: 'deposit',
      amount: '7',
      currency: coinLike,
      at: window.at(12),
      rail: 'crypto',
    });
    await seedTx({ type: 'win', amount: '3', currency: coinLike, at: window.at(12) });

    const summary = await readSummary(superAdmin, window);

    expect(forCurrency(summary.deposits, usdLike)).toEqual([
      { currency: usdLike, rail: 'crypto', total: scale18('100.5') },
      { currency: usdLike, rail: 'fiat', total: scale18('20') },
    ]);
    expect(forCurrency(summary.withdrawals, usdLike)).toEqual([
      { currency: usdLike, rail: 'crypto', total: scale18('30.25') },
    ]);
    expect(forCurrency(summary.netDeposits, usdLike)).toEqual([
      { currency: usdLike, total: scale18('85.25') },
    ]);
    expect(forCurrency(summary.ggr, usdLike)).toEqual([
      { currency: usdLike, total: scale18('27') },
    ]);
    expect(forCurrency(summary.bonusCost, usdLike)).toEqual([
      { currency: usdLike, total: scale18('5') },
    ]);
    expect(forCurrency(summary.ngr, usdLike)).toEqual([
      { currency: usdLike, total: scale18('22') },
    ]);

    expect(forCurrency(summary.deposits, coinLike)).toEqual([
      { currency: coinLike, rail: 'crypto', total: scale18('7') },
    ]);
    expect(forCurrency(summary.withdrawals, coinLike)).toEqual([]);
    expect(forCurrency(summary.netDeposits, coinLike)).toEqual([
      { currency: coinLike, total: scale18('7') },
    ]);
    expect(forCurrency(summary.ggr, coinLike)).toEqual([
      { currency: coinLike, total: scale18('-3') },
    ]);
    expect(forCurrency(summary.ngr, coinLike)).toEqual([
      { currency: coinLike, total: scale18('-3') },
    ]);
  });

  it('the summary excludes failed and pending payments', async () => {
    const window = nextWindow();
    const currency = uniqueCurrency();
    await seedTx({ type: 'deposit', amount: '10', currency, at: window.at(10), rail: 'crypto' });
    await seedTx({
      type: 'deposit',
      amount: '1000',
      currency,
      at: window.at(10),
      status: 'pending',
      rail: 'crypto',
    });
    await seedTx({
      type: 'deposit',
      amount: '500',
      currency,
      at: window.at(10),
      status: 'failed',
      rail: 'crypto',
    });
    await seedTx({
      type: 'deposit',
      amount: '250',
      currency,
      at: window.at(10),
      status: 'processing',
      rail: 'crypto',
    });
    await seedTx({
      type: 'withdrawal',
      amount: '300',
      currency,
      at: window.at(11),
      status: 'rejected',
      rail: 'crypto',
    });
    await seedTx({
      type: 'withdrawal',
      amount: '200',
      currency,
      at: window.at(11),
      status: 'pending',
      rail: 'crypto',
    });
    await seedTx({ type: 'bet', amount: '999', currency, at: window.at(11), status: 'pending' });
    await seedTx({ type: 'bonus', amount: '40', currency, at: window.at(11), status: 'failed' });

    const summary = await readSummary(superAdmin, window);

    expect(forCurrency(summary.deposits, currency)).toEqual([
      { currency, rail: 'crypto', total: scale18('10') },
    ]);
    expect(forCurrency(summary.withdrawals, currency)).toEqual([]);
    expect(forCurrency(summary.netDeposits, currency)).toEqual([
      { currency, total: scale18('10') },
    ]);
    expect(forCurrency(summary.ggr, currency)).toEqual([{ currency, total: '0' }]);
    expect(forCurrency(summary.bonusCost, currency)).toEqual([{ currency, total: '0' }]);
  });

  it('ggr series is bucketed by the requested granularity within the date range', async () => {
    const currency = uniqueCurrency();
    const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
    await seedTx({ type: 'bet', amount: '10', currency, at: at('2024-01-02') });
    await seedTx({ type: 'win', amount: '4', currency, at: at('2024-01-02') });
    await seedTx({ type: 'bet', amount: '6', currency, at: at('2024-01-05') });
    await seedTx({ type: 'bet', amount: '9', currency, at: at('2024-01-09') });
    await seedTx({ type: 'bet', amount: '1000', currency, at: at('2024-02-20') });

    const daily = await superAdmin.get(
      `/analytics/financial/ggr${query({
        dateFrom: '2024-01-01T00:00:00.000Z',
        dateTo: '2024-01-03T23:59:59.999Z',
        currency,
        granularity: 'day',
      })}`,
    );
    expect(daily.status).toBe(200);
    expect(GgrSchema.parse(await daily.json())).toEqual([
      {
        currency,
        points: [
          { bucket: '2024-01-01', ggr: '0' },
          { bucket: '2024-01-02', ggr: scale18('6') },
          { bucket: '2024-01-03', ggr: '0' },
        ],
      },
    ]);

    const weekly = await superAdmin.get(
      `/analytics/financial/ggr${query({
        dateFrom: '2024-01-01T00:00:00.000Z',
        dateTo: '2024-01-14T23:59:59.999Z',
        currency,
        granularity: 'week',
      })}`,
    );
    expect(weekly.status).toBe(200);
    expect(GgrSchema.parse(await weekly.json())).toEqual([
      {
        currency,
        points: [
          { bucket: '2024-01-01', ggr: scale18('12') },
          { bucket: '2024-01-08', ggr: scale18('9') },
        ],
      },
    ]);
  });

  it('products report lists revenue per product', async () => {
    const window = nextWindow();
    const currency = uniqueCurrency();
    const casinoGame = randomUUID();
    const originalGame = randomUUID();
    const unprojectedGame = randomUUID();
    await db()
      .insert(ledgerGame)
      .values([
        { gameId: casinoGame, providerId: randomUUID(), gameType: 'casino', version: 1 },
        { gameId: originalGame, providerId: randomUUID(), gameType: 'original', version: 1 },
      ]);
    const round = (
      gameId: string,
      betAmount: string,
      winAmount: string,
      status: 'completed' | 'active' = 'completed',
    ) => ({
      gameId,
      userId: randomUUID(),
      status,
      betAmount,
      winAmount,
      currency,
      startedAt: window.at(11),
    });
    await db()
      .insert(gameRound)
      .values([
        round(casinoGame, '10', '4'),
        round(casinoGame, '5', '1'),
        round(casinoGame, '777', '0', 'active'),
        round(originalGame, '2', '3'),
        round(unprojectedGame, '8', '0'),
      ]);

    const res = await superAdmin.get(
      `/analytics/financial/products${query({ ...window, currency })}`,
    );

    expect(res.status).toBe(200);
    expect(ProductsSchema.parse(await res.json())).toEqual([
      {
        product: 'casino',
        currency,
        stakes: scale18('15'),
        payouts: scale18('5'),
        ggr: scale18('10'),
      },
      {
        product: 'original',
        currency,
        stakes: scale18('2'),
        payouts: scale18('3'),
        ggr: scale18('-1'),
      },
      {
        product: 'unclassified',
        currency,
        stakes: scale18('8'),
        payouts: scale18('0'),
        ggr: scale18('8'),
      },
    ]);
  });

  it('a range with no activity returns zero totals rather than an error', async () => {
    const window = nextWindow();
    const currency = uniqueCurrency();

    const summary = await readSummary(superAdmin, window);
    expect(summary).toEqual({
      deposits: [],
      withdrawals: [],
      netDeposits: [],
      ggr: [],
      bonusCost: [],
      sportsbookPromotionCost: [],
      ngr: [],
    });

    const products = await superAdmin.get(`/analytics/financial/products${query(window)}`);
    expect(products.status).toBe(200);
    expect(await products.json()).toEqual([]);

    const ggr = await superAdmin.get(
      `/analytics/financial/ggr${query({ ...window, currency, granularity: 'day' })}`,
    );
    expect(ggr.status).toBe(200);
    expect(GgrSchema.parse(await ggr.json())).toEqual([
      {
        currency,
        points: ['10', '11', '12'].map((day) => ({
          bucket: `${window.dateFrom.slice(0, 4)}-03-${day}`,
          ggr: '0',
        })),
      },
    ]);
  });

  it('an admin without the analytics permission is refused every report', async () => {
    const window = nextWindow();
    const currency = uniqueCurrency();
    await seedTx({
      type: 'deposit',
      amount: '123.45',
      currency,
      at: window.at(10),
      rail: 'crypto',
    });
    const routes = ['summary', 'ggr', 'products'].map(
      (report) => `/analytics/financial/${report}${query(window)}`,
    );

    for (const client of [playerClient, noAnalyticsClient]) {
      for (const route of routes) {
        const res = await client.get(route);
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain('123.45');
      }
    }
  });

  it('an admin with read-only analytics permission reads every report', async () => {
    const window = nextWindow();
    const currency = uniqueCurrency();
    await seedTx({ type: 'deposit', amount: '12.5', currency, at: window.at(10), rail: 'crypto' });

    const summary = await readSummary(readOnlyClient, window);
    expect(forCurrency(summary.deposits, currency)).toEqual([
      { currency, rail: 'crypto', total: scale18('12.5') },
    ]);
    for (const report of ['ggr', 'products']) {
      const res = await readOnlyClient.get(`/analytics/financial/${report}${query(window)}`);
      expect(res.status).toBe(200);
    }
  });

  it('an unauthenticated caller is refused every report', async () => {
    const window = nextWindow();
    for (const report of ['summary', 'ggr', 'products']) {
      const res = await e2e.app.app.request(`/analytics/financial/${report}${query(window)}`);
      expect(res.status).toBe(401);
    }
  });

  it('an inverted date range is rejected', async () => {
    const inverted = { dateFrom: '2024-02-10T00:00:00.000Z', dateTo: '2024-02-01T00:00:00.000Z' };
    for (const report of ['summary', 'ggr', 'products']) {
      const res = await superAdmin.get(`/analytics/financial/${report}${query(inverted)}`);
      expect(res.status).toBe(400);
    }
  });
});
