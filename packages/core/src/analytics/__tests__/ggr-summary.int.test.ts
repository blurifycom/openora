import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  CACHE,
  type RunContext,
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
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { makeAuditWriter, makeCache } from '../../testing/mock.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';
import analyticsPlugin from '../plugin.js';

let db: TestDb;

const FIRST_WEEK = '2026-03-02';
const SECOND_WEEK = '2026-03-09';
const LAST_DAY = '2026-03-15';

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
  correlationId: 'ggr-summary',
});

async function seedRound(
  type: WalletTransactionType,
  amount: string,
  createdAt: string,
  {
    currency = 'USD',
    status = 'completed',
  }: { currency?: string; status?: WalletTransactionStatus } = {},
) {
  const record = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedRound: query returned no row'),
  );
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: record.id,
    type,
    amount,
    currency,
    status,
    createdAt: new Date(createdAt),
  });
}

beforeAll(async () => {
  db = await createTestDb([migrateWallet]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
  await seedRound('bet', '100', '2026-03-03T10:00:00Z');
  await seedRound('win', '30', '2026-03-04T10:00:00Z');
  await seedRound('bet_reversal', '10', '2026-03-05T10:00:00Z');
  await seedRound('bet', '50', '2026-03-10T10:00:00Z');
  await seedRound('win', '80', '2026-03-11T10:00:00Z');
  await seedRound('bet', '5', '2026-03-15T23:30:00Z');
  await seedRound('bet', '1000', '2026-03-12T10:00:00Z', { status: 'pending' });
  await seedRound('bet', '700', '2026-03-16T00:00:00Z');
  await seedRound('bet', '20', '2026-03-03T10:00:00Z', { currency: 'USDT' });
});

describe('ggr.summary through the MCP kernel (real PG)', () => {
  it('buckets completed GGR per currency over whole days, the last day included', async () => {
    const result = await bootKernel().invokeTool(
      'ggr.summary',
      { dateFrom: FIRST_WEEK, dateTo: LAST_DAY },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        dateFrom: FIRST_WEEK,
        dateTo: LAST_DAY,
        granularity: 'week',
        series: [
          {
            currency: 'USD',
            points: [
              { bucket: FIRST_WEEK, ggr: '60.000000000000000000' },
              { bucket: SECOND_WEEK, ggr: '-25.000000000000000000' },
            ],
          },
          {
            currency: 'USDT',
            points: [
              { bucket: FIRST_WEEK, ggr: '20.000000000000000000' },
              { bucket: SECOND_WEEK, ggr: '0' },
            ],
          },
        ],
      },
    });
  });

  it('narrows to one currency whatever its case', async () => {
    const result = await bootKernel().invokeTool(
      'ggr.summary',
      { dateFrom: FIRST_WEEK, dateTo: LAST_DAY, currency: 'usdt', granularity: 'month' },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        granularity: 'month',
        series: [
          { currency: 'USDT', points: [{ bucket: '2026-03-01', ggr: '20.000000000000000000' }] },
        ],
      },
    });
  });

  it('refuses a range that ends before it starts', async () => {
    const result = await bootKernel().invokeTool(
      'ggr.summary',
      { dateFrom: LAST_DAY, dateTo: FIRST_WEEK },
      runContext(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('FinancialAnalyticsService.ggrSummary (real PG)', () => {
  it('defaults to the 30 days ending on the day of now', async () => {
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    const summary = await service.ggrSummary(
      { granularity: 'week' },
      new Date(`${LAST_DAY}T12:00:00Z`),
    );

    expect(summary).toMatchObject({
      dateFrom: '2026-02-14',
      dateTo: LAST_DAY,
      granularity: 'week',
    });
    expect(summary.series.find((s) => s.currency === 'USD')?.points.at(-1)).toEqual({
      bucket: SECOND_WEEK,
      ggr: '-25.000000000000000000',
    });
  });
});
