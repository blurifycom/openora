import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MoneyReportingService } from '@openora/core/wallet/server';
import { sql } from 'drizzle-orm';
import type { WalletTransactionStatus, WalletTransactionType } from '@openora/core/contracts';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { makeCache } from '../../testing/mock.js';
import { FunnelAnalyticsService } from '../service/funnel-analytics.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateWallet]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${user}, ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

async function seedMember(
  steps: { type: WalletTransactionType; status?: WalletTransactionStatus }[],
  overrides: Partial<typeof user.$inferInsert> = {},
) {
  const account = await seedUser(db, overrides);
  const record = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: account.id, currency: 'USD' }).returning(),
    new Error('seedMember: wallet insert returned no row'),
  );
  for (const { type, status = 'completed' } of steps) {
    await db.drizzle.db
      .insert(walletTransaction)
      .values({ walletId: record.id, type, amount: '10', currency: 'USD', status });
  }
  return account;
}

async function oldFunnelCounts(from: Date, to: Date): Promise<number[]> {
  const result = await db.drizzle.db.execute<{
    registered: string;
    email_verified: string;
    first_deposit: string;
    first_bet: string;
  }>(sql`
    with deposited as (
      select distinct ${wallet.userId} as user_id
      from ${walletTransaction}
      inner join ${wallet} on ${wallet.id} = ${walletTransaction.walletId}
      where ${walletTransaction.type} = 'deposit' and ${walletTransaction.status} = 'completed'
    ),
    placed_bet as (
      select distinct ${wallet.userId} as user_id
      from ${walletTransaction}
      inner join ${wallet} on ${wallet.id} = ${walletTransaction.walletId}
      where ${walletTransaction.type} = 'bet' and ${walletTransaction.status} = 'completed'
    )
    select
      count(*) as registered,
      count(*) filter (where ${user.emailVerified}) as email_verified,
      count(*) filter (where ${user.emailVerified} and deposited.user_id is not null) as first_deposit,
      count(*) filter (
        where ${user.emailVerified}
          and deposited.user_id is not null
          and placed_bet.user_id is not null
      ) as first_bet
    from ${user}
    left join deposited on deposited.user_id = ${user.id}
    left join placed_bet on placed_bet.user_id = ${user.id}
    where ${user.createdAt} between ${from} and ${to}
  `);
  const row = result.rows[0];
  return [row?.registered, row?.email_verified, row?.first_deposit, row?.first_bet].map(Number);
}

const service = () =>
  new FunnelAnalyticsService(db.drizzle, makeCache(), new MoneyReportingService(db.drizzle));

describe('FunnelAnalyticsService.conversion (real PG)', () => {
  it('returns nested stages with drop-off rates computed from the previous stage', async () => {
    await seedMember([{ type: 'deposit' }, { type: 'bet' }]);
    await seedMember([{ type: 'deposit' }]);
    await seedMember([{ type: 'deposit', status: 'pending' }]);
    await seedMember([]);
    await seedMember([{ type: 'deposit' }, { type: 'bet' }], { emailVerified: false });
    await seedMember([{ type: 'deposit' }, { type: 'bet' }], {
      createdAt: new Date(Date.now() - 60 * DAY_MS),
    });

    const result = await service().conversion({});

    expect(result).toEqual([
      { stage: 'registered', count: 5, dropOffRate: null },
      { stage: 'email_verified', count: 4, dropOffRate: 0.2 },
      { stage: 'first_deposit', count: 2, dropOffRate: 0.5 },
      { stage: 'first_bet', count: 1, dropOffRate: 0.5 },
    ]);
  });

  it('counts what the old wallet-table query counted', async () => {
    await seedMember([{ type: 'deposit' }, { type: 'bet' }, { type: 'bet' }]);
    await seedMember([{ type: 'bet' }]);
    await seedMember([{ type: 'deposit' }, { type: 'bet', status: 'failed' }]);
    await seedMember([{ type: 'deposit', status: 'pending' }, { type: 'bet' }]);
    await seedMember([{ type: 'withdrawal' }]);
    await seedMember([{ type: 'deposit' }, { type: 'bet' }], { emailVerified: false });
    await seedMember([{ type: 'deposit' }], { createdAt: new Date(Date.now() - 60 * DAY_MS) });
    const dateFrom = new Date(Date.now() - DAY_MS).toISOString();
    const dateTo = new Date(Date.now() + DAY_MS).toISOString();

    const result = await service().conversion({ dateFrom, dateTo });

    expect(result.map((stage) => stage.count)).toEqual(
      await oldFunnelCounts(new Date(dateFrom), new Date(dateTo)),
    );
    expect(result.map((stage) => stage.count)).toEqual([6, 5, 2, 1]);
  });

  it('never divides by zero when a stage has no members', async () => {
    const result = await service().conversion({});

    expect(result.map((stage) => stage.count)).toEqual([0, 0, 0, 0]);
    expect(result.slice(1).every((stage) => stage.dropOffRate === 0)).toBe(true);
  });

  it('serves a repeat query from cache, not the database, until a fresh cache is used', async () => {
    const funnel = service();
    await seedMember([]);
    const first = await funnel.conversion({});
    await seedMember([]);

    expect(await funnel.conversion({})).toEqual(first);
    expect(first[0]?.count).toBe(1);
    expect((await service().conversion({}))[0]?.count).toBe(2);
  });
});
