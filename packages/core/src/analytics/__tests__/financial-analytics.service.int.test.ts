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
) {
  const record = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedTransaction: wallet insert returned no row'),
  );
  await db.drizzle.db
    .insert(walletTransaction)
    .values({ walletId: record.id, type, amount, currency, rail, status: 'completed' });
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
