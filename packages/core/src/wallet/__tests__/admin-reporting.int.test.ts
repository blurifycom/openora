import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { DrizzleAdminWalletReporting } from '../admin-reporting.js';

let db: TestDb;
let reporting: DrizzleAdminWalletReporting;

const AT = (iso: string) => new Date(iso);

async function seedWallet(overrides: Partial<typeof wallet.$inferInsert> = {}) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD', ...overrides })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  return row;
}

async function seedTx(
  walletId: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'deposit',
        amount: '100',
        currency: 'USD',
        status: 'completed',
        rail: 'fiat',
        createdAt: AT('2026-01-01T00:00:00.000Z'),
        ...overrides,
      })
      .returning(),
    new Error('seedTx: query returned no row'),
  );
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  reporting = new DrizzleAdminWalletReporting(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('DrizzleAdminWalletReporting.totals (real PG)', () => {
  it('returns zeroes when there is nothing to sum', async () => {
    expect(await reporting.totals()).toEqual({ deposits: '0', withdrawals: '0' });
  });

  it('sums completed deposits and withdrawals separately, ignoring other statuses and types', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { type: 'deposit', amount: '100' });
    await seedTx(w.id, { type: 'deposit', amount: '50.25' });
    await seedTx(w.id, { type: 'deposit', amount: '999', status: 'pending' });
    await seedTx(w.id, { type: 'withdrawal', amount: '30' });
    await seedTx(w.id, { type: 'withdrawal', amount: '777', status: 'failed' });
    await seedTx(w.id, { type: 'bet', amount: '400' });

    const totals = await reporting.totals();

    expect(Number(totals.deposits)).toBe(150.25);
    expect(Number(totals.withdrawals)).toBe(30);
  });
});

describe('DrizzleAdminWalletReporting.listTransactions (real PG)', () => {
  it('joins the owning wallet and maps the row onto the admin shape', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { amount: '100' });

    const { rows, total } = await reporting.listTransactions({ page: 1, limit: 20 });

    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      userId: w.userId,
      type: 'deposit',
      currency: 'USD',
      status: 'completed',
      rail: 'fiat',
    });
    expect(Number(rows[0]?.amount)).toBe(100);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('maps a null rail to null', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { rail: null });

    const { rows } = await reporting.listTransactions({ page: 1, limit: 20 });

    expect(rows[0]?.rail).toBeNull();
  });

  it('filters by userIds across wallets', async () => {
    const mine = await seedWallet();
    const other = await seedWallet();
    await seedTx(mine.id, { amount: '10' });
    await seedTx(other.id, { amount: '20' });

    const { rows, total } = await reporting.listTransactions({
      page: 1,
      limit: 20,
      userIds: [mine.userId],
    });

    expect(total).toBe(1);
    expect(rows[0]?.userId).toBe(mine.userId);
  });

  it('ignores an empty userIds array instead of matching nothing', async () => {
    const w = await seedWallet();
    await seedTx(w.id);

    const { total } = await reporting.listTransactions({ page: 1, limit: 20, userIds: [] });

    expect(total).toBe(1);
  });

  it('filters by type, currency, rail and status', async () => {
    const w = await seedWallet();
    const match = await seedTx(w.id, {
      type: 'withdrawal',
      currency: 'BTC',
      rail: 'crypto',
      status: 'pending',
    });
    await seedTx(w.id, {
      type: 'withdrawal',
      currency: 'BTC',
      rail: 'crypto',
      status: 'completed',
    });
    await seedTx(w.id, { type: 'deposit', currency: 'BTC', rail: 'crypto', status: 'pending' });
    await seedTx(w.id, { type: 'withdrawal', currency: 'USD', rail: 'fiat', status: 'pending' });

    const { rows, total } = await reporting.listTransactions({
      page: 1,
      limit: 20,
      type: 'withdrawal',
      currency: 'BTC',
      rail: 'crypto',
      status: 'pending',
    });

    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(match.id);
  });

  it('filters by an inclusive createdAt window', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { createdAt: AT('2026-01-01T00:00:00.000Z') });
    const inside = await seedTx(w.id, { createdAt: AT('2026-01-15T00:00:00.000Z') });
    const edge = await seedTx(w.id, { createdAt: AT('2026-02-01T00:00:00.000Z') });
    await seedTx(w.id, { createdAt: AT('2026-03-01T00:00:00.000Z') });

    const { rows, total } = await reporting.listTransactions({
      page: 1,
      limit: 20,
      dateFrom: AT('2026-01-10T00:00:00.000Z'),
      dateTo: AT('2026-02-01T00:00:00.000Z'),
    });

    expect(total).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual([inside.id, edge.id].sort());
  });

  it('compares amountMin/amountMax numerically, not as strings', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { amount: '9' });
    const inRange = await seedTx(w.id, { amount: '20' });
    await seedTx(w.id, { amount: '100' });

    const { rows, total } = await reporting.listTransactions({
      page: 1,
      limit: 20,
      amountMin: '10',
      amountMax: '99',
    });

    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(inRange.id);
  });

  it('sorts by createdAt descending by default', async () => {
    const w = await seedWallet();
    const older = await seedTx(w.id, { createdAt: AT('2026-01-01T00:00:00.000Z') });
    const newer = await seedTx(w.id, { createdAt: AT('2026-02-01T00:00:00.000Z') });

    const { rows } = await reporting.listTransactions({ page: 1, limit: 20 });

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it('sorts by amount numerically when asked, ascending', async () => {
    const w = await seedWallet();
    const nine = await seedTx(w.id, { amount: '9' });
    const ten = await seedTx(w.id, { amount: '10' });
    const hundred = await seedTx(w.id, { amount: '100' });

    const { rows } = await reporting.listTransactions({
      page: 1,
      limit: 20,
      sortBy: 'amount',
      sortOrder: 'asc',
    });

    expect(rows.map((r) => r.id)).toEqual([nine.id, ten.id, hundred.id]);
  });

  it('breaks a sort tie on id so paging never repeats or drops a row', async () => {
    const w = await seedWallet();
    const sameInstant = AT('2026-01-01T00:00:00.000Z');
    await Promise.all([
      seedTx(w.id, { createdAt: sameInstant }),
      seedTx(w.id, { createdAt: sameInstant }),
      seedTx(w.id, { createdAt: sameInstant }),
    ]);

    const first = await reporting.listTransactions({ page: 1, limit: 2 });
    const second = await reporting.listTransactions({ page: 2, limit: 2 });

    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(1);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(3);
  });

  it('pages the rows while total stays the size of the whole filtered set', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { createdAt: AT('2026-01-01T00:00:00.000Z') });
    const middle = await seedTx(w.id, { createdAt: AT('2026-01-02T00:00:00.000Z') });
    await seedTx(w.id, { createdAt: AT('2026-01-03T00:00:00.000Z') });

    const { rows, total } = await reporting.listTransactions({ page: 2, limit: 1 });

    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([middle.id]);
  });
});

describe('DrizzleAdminWalletReporting.getTransaction (real PG)', () => {
  it('returns null when no row matches', async () => {
    expect(await reporting.getTransaction(randomUUID())).toBeNull();
  });

  it('surfaces the provider columns alongside the joined userId', async () => {
    const w = await seedWallet();
    const tx = await seedTx(w.id, { providerName: 'stripe', providerRefId: 'pi_123' });

    const detail = await reporting.getTransaction(tx.id);

    expect(detail).toMatchObject({
      id: tx.id,
      userId: w.userId,
      providerName: 'stripe',
      providerRefId: 'pi_123',
    });
  });

  it('maps unset provider columns to null and surfaces the review columns', async () => {
    const w = await seedWallet();
    const reviewer = randomUUID();
    const tx = await seedTx(w.id, {
      reviewedBy: reviewer,
      reviewedAt: AT('2026-01-02T00:00:00.000Z'),
      reviewReason: 'manual',
    });

    const detail = await reporting.getTransaction(tx.id);

    expect(detail).toMatchObject({
      providerName: null,
      providerRefId: null,
      reviewedBy: reviewer,
      reviewReason: 'manual',
    });
    expect(detail?.reviewedAt).toEqual(AT('2026-01-02T00:00:00.000Z'));
  });
});
