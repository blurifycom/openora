import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { WalletRail, WalletTransactionType } from '@openora/core/contracts';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { makeCache } from '../../testing/mock.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';

let db: TestDb;

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
});

async function seedTransaction(
  type: WalletTransactionType,
  amount: string,
  currency: string,
  rail: WalletRail | null = null,
  createdAt?: Date,
) {
  const record = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedTransaction: wallet insert returned no row'),
  );
  await db.drizzle.db
    .insert(walletTransaction)
    .values({ walletId: record.id, type, amount, currency, rail, status: 'completed', createdAt });
}

const byCurrency = <T extends { currency: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.currency.localeCompare(b.currency));

describe('FinancialAnalyticsService.summary (real PG)', () => {
  it('splits deposits and withdrawals by currency and rail and computes net deposits, GGR, bonus cost and NGR', async () => {
    await seedTransaction('deposit', '500', 'USD', 'fiat');
    await seedTransaction('deposit', '75', 'EUR');
    await seedTransaction('withdrawal', '120', 'USD', 'crypto');
    await seedTransaction('bonus', '30', 'USD');
    await seedTransaction('bet', '200', 'USD');
    await seedTransaction('win', '110', 'USD');
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    const result = await service.summary({});

    expect(byCurrency(result.deposits)).toEqual([
      { currency: 'EUR', rail: null, total: expect.stringMatching(/^75(\.0+)?$/) },
      { currency: 'USD', rail: 'fiat', total: expect.stringMatching(/^500(\.0+)?$/) },
    ]);
    expect(result.withdrawals).toEqual([
      { currency: 'USD', rail: 'crypto', total: expect.stringMatching(/^120(\.0+)?$/) },
    ]);
    expect(byCurrency(result.netDeposits)).toEqual([
      { currency: 'EUR', total: expect.stringMatching(/^75(\.0+)?$/) },
      { currency: 'USD', total: expect.stringMatching(/^350(\.0+)?$/) },
    ]);
    expect(byCurrency(result.ggr)).toEqual([
      { currency: 'EUR', total: '0' },
      { currency: 'USD', total: expect.stringMatching(/^90(\.0+)?$/) },
    ]);
    expect(byCurrency(result.bonusCost)).toEqual([
      { currency: 'EUR', total: '0' },
      { currency: 'USD', total: expect.stringMatching(/^30(\.0+)?$/) },
    ]);
    expect(byCurrency(result.ngr)).toEqual([
      { currency: 'EUR', total: '0' },
      { currency: 'USD', total: expect.stringMatching(/^60(\.0+)?$/) },
    ]);
    expect(result.sportsbookPromotionCost).toEqual([]);
  });

  it('serves a repeat query from cache, not the database, until a fresh cache is used', async () => {
    await seedTransaction('deposit', '10', 'USD', 'fiat');
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());
    const first = await service.summary({});
    await seedTransaction('deposit', '90', 'USD', 'fiat');

    expect(await service.summary({})).toEqual(first);
    const fresh = await new FinancialAnalyticsService(db.drizzle, makeCache()).summary({});
    expect(fresh.deposits).toEqual([
      { currency: 'USD', rail: 'fiat', total: expect.stringMatching(/^100(\.0+)?$/) },
    ]);
  });
});

describe('FinancialAnalyticsService.ggr (real PG)', () => {
  it('returns one series per currency with a zero bucket on a day without rounds', async () => {
    const day = (d: string) => new Date(`2026-03-${d}T10:00:00Z`);
    await seedTransaction('bet', '100', 'USD', null, day('03'));
    await seedTransaction('win', '40', 'USD', null, day('03'));
    await seedTransaction('bet', '10', 'USD', null, day('05'));
    await seedTransaction('bet', '50', 'EUR', null, day('03'));
    await seedTransaction('win', '20', 'EUR', null, day('03'));
    await seedTransaction('bet', '5', 'EUR', null, day('05'));
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    const series = await service.ggr({
      dateFrom: '2026-03-03T00:00:00.000Z',
      dateTo: '2026-03-05T23:59:59.999Z',
      granularity: 'day',
    });

    expect(series.map((s) => s.currency)).toEqual(['EUR', 'USD']);
    const totals = (currency: string) =>
      series.find((s) => s.currency === currency)?.points.map((p) => [p.bucket, Number(p.ggr)]);
    expect(totals('USD')).toEqual([
      ['2026-03-03', 60],
      ['2026-03-04', 0],
      ['2026-03-05', 10],
    ]);
    expect(totals('EUR')).toEqual([
      ['2026-03-03', 30],
      ['2026-03-04', 0],
      ['2026-03-05', 5],
    ]);
  });
});
