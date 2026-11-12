import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  CACHE,
  WALLET_TRANSACTION_STATUSES,
  type RunContext,
  type WalletRail,
  type WalletTransactionStatus,
  type WalletTransactionType,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { makeAuditWriter, makeCache } from '../../testing/mock.js';
import { PAYMENTS_FLOW_MAX_ROWS } from '../contract/index.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';
import analyticsPlugin from '../plugin.js';

let db: TestDb;
let walletId: string;

const FIRST_DAY = '2026-04-06';
const LAST_DAY = '2026-04-14';

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(CACHE, () => makeCache());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('analytics');
  analyticsPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'admin', adminId: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'analytics-agent-tools',
});

type SeededTx = {
  type: WalletTransactionType;
  amount: string;
  createdAt: string;
  currency?: string;
  status?: WalletTransactionStatus;
  rail?: WalletRail | null;
};

const txRow = ({
  type,
  amount,
  createdAt,
  currency = 'USD',
  status = 'completed',
  rail = null,
}: SeededTx) => ({
  walletId,
  type,
  amount,
  currency,
  status,
  rail,
  createdAt: new Date(createdAt),
});

async function seedTxs(txs: readonly SeededTx[]) {
  await db.drizzle.db.insert(walletTransaction).values(txs.map(txRow));
}

async function seedCasinoRound(betAmount: string, winAmount: string, startedAt: string) {
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio' })
      .returning(),
    new Error('seed: no provider'),
  );
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name: 'casino',
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'agg',
        gameType: 'casino',
      })
      .returning(),
    new Error('seed: no game'),
  );
  await db.drizzle.db.insert(gameRound).values({
    gameId: row.id,
    userId: randomUUID(),
    currency: 'USD',
    betAmount,
    winAmount,
    status: 'completed',
    startedAt: new Date(startedAt),
  });
}

beforeAll(async () => {
  db = await createTestDb([migrateWallet, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet}, ${gameRound}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
  walletId = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seed: no wallet'),
  ).id;
});

describe('payments.flow_daily through the MCP kernel (real PG)', () => {
  beforeEach(async () => {
    await seedTxs([
      { type: 'deposit', amount: '100', createdAt: '2026-04-06T00:00:00Z' },
      { type: 'deposit', amount: '50.25', createdAt: '2026-04-06T23:59:59Z' },
      { type: 'deposit', amount: '70', createdAt: '2026-04-06T12:00:00Z', status: 'failed' },
      { type: 'withdrawal', amount: '30', createdAt: '2026-04-07T08:00:00Z', status: 'on_hold' },
      { type: 'withdrawal', amount: '15', createdAt: '2026-04-07T09:00:00Z', status: 'pending' },
      { type: 'deposit', amount: '0.5', createdAt: '2026-04-14T23:00:00Z', currency: 'BTC' },
      {
        type: 'deposit',
        amount: '1',
        createdAt: '2026-04-13T10:00:00Z',
        status: 'refunded',
        currency: 'BTC',
      },
      { type: 'bet', amount: '999', createdAt: '2026-04-07T10:00:00Z' },
      { type: 'deposit', amount: '999', createdAt: '2026-04-05T23:59:59Z' },
      { type: 'deposit', amount: '999', createdAt: '2026-04-15T00:00:00Z' },
    ]);
  });

  it('counts and sums deposits and withdrawals per UTC day, type, status and currency', async () => {
    const result = await bootKernel().invokeTool(
      'payments.flow_daily',
      { dateFrom: FIRST_DAY, dateTo: LAST_DAY },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        dateFrom: FIRST_DAY,
        dateTo: LAST_DAY,
        granularity: 'day',
        rows: [
          {
            bucket: '2026-04-06',
            type: 'deposit',
            status: 'completed',
            currency: 'USD',
            count: 2,
            amount: '150.250000000000000000',
          },
          {
            bucket: '2026-04-06',
            type: 'deposit',
            status: 'failed',
            currency: 'USD',
            count: 1,
            amount: '70.000000000000000000',
          },
          {
            bucket: '2026-04-07',
            type: 'withdrawal',
            status: 'pending',
            currency: 'USD',
            count: 1,
            amount: '15.000000000000000000',
          },
          {
            bucket: '2026-04-07',
            type: 'withdrawal',
            status: 'on_hold',
            currency: 'USD',
            count: 1,
            amount: '30.000000000000000000',
          },
          {
            bucket: '2026-04-13',
            type: 'deposit',
            status: 'refunded',
            currency: 'BTC',
            count: 1,
            amount: '1.000000000000000000',
          },
          {
            bucket: '2026-04-14',
            type: 'deposit',
            status: 'completed',
            currency: 'BTC',
            count: 1,
            amount: '0.500000000000000000',
          },
        ],
        truncated: false,
      },
    });
  });

  it('labels a week bucket by its Monday and narrows by type, status and currency whatever its case', async () => {
    const kernel = bootKernel();

    const weekly = await kernel.invokeTool(
      'payments.flow_daily',
      { dateFrom: FIRST_DAY, dateTo: LAST_DAY, granularity: 'week', currency: 'btc' },
      runContext(),
    );
    const held = await kernel.invokeTool(
      'payments.flow_daily',
      { dateFrom: FIRST_DAY, dateTo: LAST_DAY, types: ['withdrawal'], statuses: ['on_hold'] },
      runContext(),
    );

    expect(weekly).toMatchObject({
      ok: true,
      output: {
        granularity: 'week',
        rows: [
          { bucket: '2026-04-13', type: 'deposit', status: 'completed', currency: 'BTC', count: 1 },
          { bucket: '2026-04-13', type: 'deposit', status: 'refunded', currency: 'BTC', count: 1 },
        ],
      },
    });
    expect(held).toMatchObject({
      ok: true,
      output: {
        rows: [{ bucket: '2026-04-07', status: 'on_hold', amount: '30.000000000000000000' }],
      },
    });
    expect(held.ok && held.output['rows']).toHaveLength(1);
  });

  it('refuses a range longer than 92 days and a type that is not a payment', async () => {
    const kernel = bootKernel();

    const tooLong = await kernel.invokeTool(
      'payments.flow_daily',
      { dateFrom: '2026-01-01', dateTo: '2026-04-03' },
      runContext(),
    );
    const bets = await kernel.invokeTool('payments.flow_daily', { types: ['bet'] }, runContext());

    expect(tooLong).toMatchObject({
      ok: false,
      error: 'invalid_input',
      issues: [expect.objectContaining({ path: 'dateFrom' })],
    });
    expect(bets).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('FinancialAnalyticsService.paymentsFlow at its row cap (real PG)', () => {
  beforeEach(async () => {
    const days = Array.from({ length: 63 }, (_, day) =>
      new Date(Date.parse('2026-01-01T12:00:00Z') + day * 24 * 60 * 60 * 1000).toISOString(),
    );
    const rows = days.flatMap((createdAt) =>
      WALLET_TRANSACTION_STATUSES.flatMap((status) =>
        (['deposit', 'withdrawal'] as const).map((type) => ({
          type,
          amount: '1',
          createdAt,
          status,
        })),
      ),
    );
    await seedTxs(rows);
  });

  it('returns the oldest 1000 groups and says more matched', async () => {
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    const flow = await service.paymentsFlow({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-04',
      granularity: 'day',
    });

    expect(flow.rows).toHaveLength(PAYMENTS_FLOW_MAX_ROWS);
    expect(flow.truncated).toBe(true);
    expect(flow.rows[0]).toMatchObject({
      bucket: '2026-01-01',
      type: 'deposit',
      status: 'pending',
    });
    expect(flow.rows.at(-1)).toMatchObject({
      bucket: '2026-03-04',
      type: 'deposit',
      status: 'refunded',
    });
  });
});

describe('financial.summary through the MCP kernel (real PG)', () => {
  beforeEach(async () => {
    await seedTxs([
      { type: 'deposit', amount: '500', createdAt: '2026-04-07T10:00:00Z', rail: 'fiat' },
      { type: 'deposit', amount: '100', createdAt: '2026-04-08T10:00:00Z' },
      { type: 'deposit', amount: '999', createdAt: '2026-04-08T11:00:00Z', status: 'pending' },
      { type: 'withdrawal', amount: '200', createdAt: '2026-04-09T10:00:00Z', rail: 'fiat' },
      { type: 'bonus', amount: '30', createdAt: '2026-04-09T11:00:00Z' },
      { type: 'cashback', amount: '7', createdAt: '2026-04-09T12:00:00Z' },
      { type: 'bet', amount: '100', createdAt: '2026-04-10T10:00:00Z' },
      { type: 'win', amount: '40', createdAt: '2026-04-10T11:00:00Z' },
      {
        type: 'deposit',
        amount: '2',
        createdAt: '2026-04-11T10:00:00Z',
        currency: 'BTC',
        rail: 'crypto',
      },
      { type: 'deposit', amount: '999', createdAt: '2026-04-15T00:00:00Z' },
    ]);
    await seedCasinoRound('100', '40', '2026-04-10T10:00:00Z');
  });

  it('totals each currency, leaves cashback out of bonus cost and splits stakes by product', async () => {
    const result = await bootKernel().invokeTool(
      'financial.summary',
      { dateFrom: FIRST_DAY, dateTo: LAST_DAY },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        dateFrom: FIRST_DAY,
        dateTo: LAST_DAY,
        currencies: [
          {
            currency: 'BTC',
            deposits: '2.000000000000000000',
            withdrawals: '0',
            netDeposits: '2.000000000000000000',
            ggr: '0',
            bonusCost: '0',
            ngr: '0',
          },
          {
            currency: 'USD',
            deposits: '600.000000000000000000',
            withdrawals: '200.000000000000000000',
            netDeposits: '370.000000000000000000',
            ggr: '60.000000000000000000',
            bonusCost: '30.000000000000000000',
            ngr: '30.000000000000000000',
          },
        ],
        products: [
          {
            product: 'casino',
            currency: 'USD',
            stakes: '100.000000000000000000',
            payouts: '40.000000000000000000',
            ggr: '60.000000000000000000',
          },
        ],
        truncated: false,
      },
    });
  });

  it('narrows to one currency whatever its case and refuses a range longer than 366 days', async () => {
    const kernel = bootKernel();

    const btc = await kernel.invokeTool(
      'financial.summary',
      { dateFrom: FIRST_DAY, dateTo: LAST_DAY, currency: 'btc' },
      runContext(),
    );
    const tooLong = await kernel.invokeTool(
      'financial.summary',
      { dateFrom: '2025-01-01', dateTo: '2026-01-02' },
      runContext(),
    );

    expect(btc).toMatchObject({
      ok: true,
      output: { currencies: [{ currency: 'BTC' }], products: [] },
    });
    expect(btc.ok && btc.output['currencies']).toHaveLength(1);
    expect(tooLong).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
