import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AdminUserDirectory, PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

let db: TestDb;

function makeService(directory?: Partial<AdminUserDirectory>) {
  return new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    ...(directory ? { directory: mock<AdminUserDirectory>(directory) } : {}),
  });
}

async function seedWallet() {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: 'USD', amount: '0' });
  return row;
}

async function seedTx(
  walletId: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'withdrawal',
        amount: '10',
        currency: 'USD',
        status: 'pending',
        rail: 'fiat',
        ...overrides,
      })
      .returning(),
    new Error('seedTx: no row'),
  );
}

const page = { page: 1, limit: 50 };
const sortedIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const itemIds = (items: { transactionId: string }[]) => items.map((i) => i.transactionId).sort();

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.listWithdrawals filters (real PG)', () => {
  it('filters by status, currency and rail, each on its own and combined', async () => {
    const w = await seedWallet();
    const target = await seedTx(w.id, { status: 'on_hold', currency: 'BTC', rail: 'crypto' });
    await seedTx(w.id, { status: 'pending', currency: 'BTC', rail: 'crypto' });
    await seedTx(w.id, { status: 'on_hold', currency: 'USD', rail: 'crypto' });
    await seedTx(w.id, { status: 'on_hold', currency: 'BTC', rail: 'fiat' });
    const svc = makeService();

    expect((await svc.listWithdrawals({ ...page, status: 'on_hold' })).total).toBe(3);
    expect((await svc.listWithdrawals({ ...page, currency: 'BTC' })).total).toBe(3);
    expect((await svc.listWithdrawals({ ...page, rail: 'crypto' })).total).toBe(3);
    const combined = await svc.listWithdrawals({
      ...page,
      status: 'on_hold',
      currency: 'BTC',
      rail: 'crypto',
    });
    expect(itemIds(combined.items)).toEqual([target.id]);
  });

  it('treats minAmount and maxAmount as inclusive bounds', async () => {
    const w = await seedWallet();
    const low = await seedTx(w.id, { amount: '10' });
    const mid = await seedTx(w.id, { amount: '50' });
    const high = await seedTx(w.id, { amount: '100' });
    const svc = makeService();

    expect(itemIds((await svc.listWithdrawals({ ...page, minAmount: '50' })).items)).toEqual(
      sortedIds([mid, high]),
    );
    expect(itemIds((await svc.listWithdrawals({ ...page, maxAmount: '50' })).items)).toEqual(
      sortedIds([low, mid]),
    );
    expect(
      itemIds((await svc.listWithdrawals({ ...page, minAmount: '50', maxAmount: '50' })).items),
    ).toEqual([mid.id]);
  });

  it('treats dateFrom and dateTo as inclusive bounds', async () => {
    const w = await seedWallet();
    const jan1 = await seedTx(w.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const jan2 = await seedTx(w.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });
    const jan3 = await seedTx(w.id, { createdAt: new Date('2026-01-03T00:00:00.000Z') });
    const svc = makeService();

    const from = await svc.listWithdrawals({ ...page, dateFrom: '2026-01-02T00:00:00.000Z' });
    expect(itemIds(from.items)).toEqual(sortedIds([jan2, jan3]));
    const to = await svc.listWithdrawals({ ...page, dateTo: '2026-01-02T00:00:00.000Z' });
    expect(itemIds(to.items)).toEqual(sortedIds([jan1, jan2]));
  });

  it('searches by exact user id, and not by a different one', async () => {
    const mine = await seedWallet();
    const other = await seedWallet();
    const tx = await seedTx(mine.id);
    await seedTx(other.id);
    const svc = makeService();

    expect(itemIds((await svc.listWithdrawals({ ...page, search: mine.userId })).items)).toEqual([
      tx.id,
    ]);
    expect((await svc.listWithdrawals({ ...page, search: randomUUID() })).total).toBe(0);
  });

  it('searches an EVM address case-insensitively but any other address case-sensitively', async () => {
    const w = await seedWallet();
    const evm = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const btc = 'bc1qAbCdEfGhIjK';
    const evmTx = await seedTx(w.id, { destinationAddress: evm });
    const btcTx = await seedTx(w.id, { destinationAddress: btc });
    const svc = makeService();

    expect(
      itemIds((await svc.listWithdrawals({ ...page, search: evm.toLowerCase() })).items),
    ).toEqual([evmTx.id]);
    expect(itemIds((await svc.listWithdrawals({ ...page, search: btc })).items)).toEqual([
      btcTx.id,
    ]);
    expect((await svc.listWithdrawals({ ...page, search: btc.toLowerCase() })).total).toBe(0);
  });

  it('resolves an email or username fragment through the directory, and finds nothing for an unknown one', async () => {
    const mine = await seedWallet();
    const other = await seedWallet();
    const tx = await seedTx(mine.id);
    await seedTx(other.id);
    const findPlayerIds = vi.fn(async (term: string) => (term === 'alice' ? [mine.userId] : []));
    const svc = makeService({ findPlayerIds, lookupPlayers: vi.fn(async () => []) });

    expect(itemIds((await svc.listWithdrawals({ ...page, search: 'alice' })).items)).toEqual([
      tx.id,
    ]);
    expect((await svc.listWithdrawals({ ...page, search: 'nobody' })).total).toBe(0);
  });

  it('drops a player the directory does not know when a kyc filter is set', async () => {
    const known = await seedWallet();
    const unknown = await seedWallet();
    await seedTx(known.id);
    await seedTx(unknown.id);
    const svc = makeService({
      lookupPlayers: vi.fn(async () => [
        { userId: known.userId, username: 'k', kycStatus: 'pending' } as never,
      ]),
    });

    const { items } = await svc.listWithdrawals({ ...page, kycStatus: 'pending' });

    expect(items.map((i) => i.userId)).toEqual([known.userId]);
  });
});

describe('WalletService.summarizeWithdrawals (real PG)', () => {
  it('counts pending and on_hold, totals per currency, and ignores settled and non-withdrawal rows', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { status: 'pending', amount: '10', currency: 'USD' });
    await seedTx(w.id, { status: 'pending', amount: '5', currency: 'USD' });
    await seedTx(w.id, { status: 'on_hold', amount: '2', currency: 'BTC' });
    await seedTx(w.id, { status: 'completed', amount: '999', currency: 'USD' });
    await seedTx(w.id, { type: 'deposit', status: 'pending', amount: '999' });

    const summary = await makeService().summarizeWithdrawals({});

    expect(summary.pendingCount).toBe(2);
    expect(summary.onHoldCount).toBe(1);
    expect(summary.queuedTotals).toEqual([
      { currency: 'BTC', amount: '2.000000000000000000' },
      { currency: 'USD', amount: '15.000000000000000000' },
    ]);
    expect(summary.avgPendingWaitSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an empty queue as zeros and a null wait', async () => {
    expect(await makeService().summarizeWithdrawals({})).toEqual({
      pendingCount: 0,
      onHoldCount: 0,
      queuedTotals: [],
      avgPendingWaitSeconds: null,
    });
  });

  it('averages the wait of pending rows only', async () => {
    const w = await seedWallet();
    const ago = (s: number) => new Date(Date.now() - s * 1000);
    await seedTx(w.id, { status: 'pending', createdAt: ago(100) });
    await seedTx(w.id, { status: 'pending', createdAt: ago(200) });
    await seedTx(w.id, { status: 'on_hold', createdAt: ago(100_000) });

    const { avgPendingWaitSeconds } = await makeService().summarizeWithdrawals({});

    expect(avgPendingWaitSeconds).toBeGreaterThan(145);
    expect(avgPendingWaitSeconds).toBeLessThan(160);
  });

  it('narrows by the shared filters', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { currency: 'BTC', amount: '1' });
    await seedTx(w.id, { currency: 'USD', amount: '1' });

    const summary = await makeService().summarizeWithdrawals({ currency: 'BTC' });

    expect(summary.pendingCount).toBe(1);
    expect(summary.queuedTotals.map((t) => t.currency)).toEqual(['BTC']);
  });

  it('narrows by kyc status through the directory', async () => {
    const approved = await seedWallet();
    const other = await seedWallet();
    await seedTx(approved.id);
    await seedTx(other.id);
    const findUserIdsByKycStatus = vi.fn(async () => [approved.userId]);

    const summary = await makeService({ findUserIdsByKycStatus }).summarizeWithdrawals({
      kycStatus: 'approved',
    });

    expect(summary.pendingCount).toBe(1);
    expect(findUserIdsByKycStatus).toHaveBeenCalledWith('approved');
  });

  it('fails closed to an empty queue when a kyc filter matches no one or no directory is bound', async () => {
    const w = await seedWallet();
    await seedTx(w.id);
    const empty = {
      pendingCount: 0,
      onHoldCount: 0,
      queuedTotals: [],
      avgPendingWaitSeconds: null,
    };

    expect(await makeService().summarizeWithdrawals({ kycStatus: 'approved' })).toEqual(empty);
    expect(
      await makeService({ findUserIdsByKycStatus: vi.fn(async () => []) }).summarizeWithdrawals({
        kycStatus: 'approved',
      }),
    ).toEqual(empty);
  });
});

describe('WalletService.listWithdrawals ordering and rows (real PG)', () => {
  it('lists newest first by default and oldest first when asked for ascending', async () => {
    const w = await seedWallet();
    const oldest = await seedTx(w.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const middle = await seedTx(w.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });
    const newest = await seedTx(w.id, { createdAt: new Date('2026-01-03T00:00:00.000Z') });
    const svc = makeService();
    const order = (items: { transactionId: string }[]) => items.map((i) => i.transactionId);

    expect(order((await svc.listWithdrawals(page)).items)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
    expect(order((await svc.listWithdrawals({ ...page, sortOrder: 'desc' })).items)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
    expect(order((await svc.listWithdrawals({ ...page, sortOrder: 'asc' })).items)).toEqual([
      oldest.id,
      middle.id,
      newest.id,
    ]);
  });

  it('reports the rail each withdrawal went out on', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { rail: 'crypto', currency: 'BTC' });
    await seedTx(w.id, { rail: 'fiat' });
    const svc = makeService();

    const { items } = await svc.listWithdrawals(page);

    expect(items.map((i) => i.rail).sort()).toEqual(['crypto', 'fiat']);
  });
});

describe('WalletService.summarizeWithdrawals totals order (real PG)', () => {
  it('lists the queued totals by currency code whatever order the rows arrived in', async () => {
    const w = await seedWallet();
    for (const currency of ['XRP', 'BTC', 'USD', 'ETH', 'LTC', 'DOGE']) {
      await seedTx(w.id, { currency, amount: '1' });
    }

    const summary = await makeService().summarizeWithdrawals({});

    expect(summary.queuedTotals.map((t) => t.currency)).toEqual([
      'BTC',
      'DOGE',
      'ETH',
      'LTC',
      'USD',
      'XRP',
    ]);
  });
});
