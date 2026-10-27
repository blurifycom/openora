import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ExchangeRateReader, PaymentAdapter } from '@openora/core/contracts';
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
import { UnsupportedAmountCurrencyError, WalletService } from '../service/wallet.service.js';

let db: TestDb;

// USD value of one unit; a currency missing from the table has no quote.
const rates = (perUnit: Record<string, string>) =>
  mock<ExchangeRateReader>({
    getRate: vi.fn(async (from: string) => {
      const rate = perUnit[from];
      return rate ? { rate, asOf: new Date().toISOString() } : null;
    }),
  });

function makeService(rateReader?: ExchangeRateReader) {
  return new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    ...(rateReader ? { rates: rateReader } : {}),
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
        type: 'deposit',
        amount: '10',
        currency: 'USD',
        status: 'completed',
        rail: 'fiat',
        direction: 'credit',
        ...overrides,
      })
      .returning(),
    new Error('seedTx: no row'),
  );
}

const page = { page: 1, limit: 50 };
const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();
const sorted = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

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

describe('WalletService.getTransactions (real PG)', () => {
  it("returns only the caller's rows, never another player's", async () => {
    const mine = await seedWallet();
    const theirs = await seedWallet();
    const own = await seedTx(mine.id);
    await seedTx(theirs.id);

    const { items, total } = await makeService().getTransactions({ userId: mine.userId, ...page });

    expect(ids(items)).toEqual([own.id]);
    expect(total).toBe(1);
  });

  it('returns nothing for a player with no wallet', async () => {
    const other = await seedWallet();
    await seedTx(other.id);

    expect(await makeService().getTransactions({ userId: randomUUID(), ...page })).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('filters by type, status and currency, and ANDs them together', async () => {
    const w = await seedWallet();
    const target = await seedTx(w.id, { type: 'withdrawal', status: 'pending', currency: 'BTC' });
    await seedTx(w.id, { type: 'deposit', status: 'pending', currency: 'BTC' });
    await seedTx(w.id, { type: 'withdrawal', status: 'completed', currency: 'BTC' });
    await seedTx(w.id, { type: 'withdrawal', status: 'pending', currency: 'USD' });
    const svc = makeService();
    const userId = w.userId;

    expect((await svc.getTransactions({ userId, ...page, types: ['withdrawal'] })).total).toBe(3);
    expect((await svc.getTransactions({ userId, ...page, statuses: ['pending'] })).total).toBe(3);
    expect((await svc.getTransactions({ userId, ...page, currencies: ['BTC'] })).total).toBe(3);
    const all = await svc.getTransactions({
      userId,
      ...page,
      types: ['withdrawal'],
      statuses: ['pending'],
      currencies: ['BTC'],
    });
    expect(ids(all.items)).toEqual([target.id]);
  });

  it('treats an empty filter list as no filter', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { type: 'withdrawal' });
    await seedTx(w.id, { type: 'deposit' });

    const { total } = await makeService().getTransactions({
      userId: w.userId,
      ...page,
      types: [],
      statuses: [],
      currencies: [],
    });

    expect(total).toBe(2);
  });

  it('treats from and to as inclusive bounds', async () => {
    const w = await seedWallet();
    const jan1 = await seedTx(w.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const jan2 = await seedTx(w.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });
    const jan3 = await seedTx(w.id, { createdAt: new Date('2026-01-03T00:00:00.000Z') });
    const svc = makeService();
    const userId = w.userId;

    const from = await svc.getTransactions({ userId, ...page, from: '2026-01-02T00:00:00.000Z' });
    expect(ids(from.items)).toEqual(sorted([jan2, jan3]));
    const to = await svc.getTransactions({ userId, ...page, to: '2026-01-02T00:00:00.000Z' });
    expect(ids(to.items)).toEqual(sorted([jan1, jan2]));
  });

  it('searches by id prefix, provider reference or tx hash, and treats like wildcards literally', async () => {
    const w = await seedWallet();
    const byRef = await seedTx(w.id, { providerRefId: 'psp-123' });
    const byHash = await seedTx(w.id, { txHash: '0xhash' });
    const plain = await seedTx(w.id);
    const svc = makeService();
    const userId = w.userId;

    expect(ids((await svc.getTransactions({ userId, ...page, search: 'psp-123' })).items)).toEqual([
      byRef.id,
    ]);
    expect(ids((await svc.getTransactions({ userId, ...page, search: '0xhash' })).items)).toEqual([
      byHash.id,
    ]);
    expect(
      ids(
        (await svc.getTransactions({ userId, ...page, search: plain.id.slice(0, 8).toUpperCase() }))
          .items,
      ),
    ).toEqual([plain.id]);
    expect((await svc.getTransactions({ userId, ...page, search: 'psp-12' })).total).toBe(0);
    expect((await svc.getTransactions({ userId, ...page, search: '%' })).total).toBe(0);
  });

  it('hides review and reference data from the player and shows it to internal callers', async () => {
    const w = await seedWallet();
    const reviewer = randomUUID();
    await seedTx(w.id, {
      type: 'withdrawal',
      reviewedBy: reviewer,
      reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
      reviewReason: 'looks fine',
      referenceCurrency: 'USD',
      referenceAmount: '10',
      referenceRate: '1',
      referenceRateAsOf: new Date('2026-01-01T00:00:00.000Z'),
    });
    const svc = makeService();

    const [player] = (await svc.getTransactions({ userId: w.userId, ...page })).items;
    expect(player).toMatchObject({
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      reference: null,
    });

    const [internal] = (
      await svc.getTransactions({ userId: w.userId, ...page, includeInternal: true })
    ).items;
    expect(internal).toMatchObject({
      reviewedBy: reviewer,
      reviewedAt: '2026-01-02T00:00:00.000Z',
      reviewReason: 'looks fine',
    });
    expect(internal?.reference).not.toBeNull();
  });

  it('shows the reason on a manual adjustment to the player, since the player is owed an explanation', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { type: 'manual_credit', reviewReason: 'goodwill' });
    await seedTx(w.id, { type: 'withdrawal', reviewReason: 'internal note' });

    const { items } = await makeService().getTransactions({ userId: w.userId, ...page });

    const reasons = new Map(items.map((i) => [i.type, i.reviewReason]));
    expect(reasons.get('manual_credit')).toBe('goodwill');
    expect(reasons.get('withdrawal')).toBeNull();
  });

  it('pages the result while total counts every match', async () => {
    const w = await seedWallet();
    for (let day = 1; day <= 5; day++) {
      await seedTx(w.id, { createdAt: new Date(`2026-01-0${day}T00:00:00.000Z`) });
    }

    const { items, total } = await makeService().getTransactions({
      userId: w.userId,
      page: 2,
      limit: 2,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });

    expect(total).toBe(5);
    expect(items.map((i) => i.createdAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ]);
  });

  it('sorts newest first by default', async () => {
    const w = await seedWallet();
    const older = await seedTx(w.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = await seedTx(w.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });

    const { items } = await makeService().getTransactions({ userId: w.userId, ...page });

    expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
  });

  describe('sorting by amount in a display currency', () => {
    it('orders by the converted, signed value and puts an unpriced currency last', async () => {
      const w = await seedWallet();
      const btc = await seedTx(w.id, { amount: '1', currency: 'BTC' });
      const usd = await seedTx(w.id, { amount: '500', currency: 'USD' });
      const eur = await seedTx(w.id, { amount: '100', currency: 'EUR' });
      const debit = await seedTx(w.id, {
        type: 'withdrawal',
        amount: '300',
        currency: 'USD',
        direction: 'debit',
      });
      const unpriced = await seedTx(w.id, { amount: '9999', currency: 'ZZZ' });
      const svc = makeService(rates({ BTC: '1000', EUR: '2' }));

      const desc = await svc.getTransactions({
        userId: w.userId,
        ...page,
        sortBy: 'amount',
        sortOrder: 'desc',
        amountCurrency: 'USD',
      });
      expect(desc.items.map((i) => i.id)).toEqual([btc.id, usd.id, eur.id, debit.id, unpriced.id]);

      const asc = await svc.getTransactions({
        userId: w.userId,
        ...page,
        sortBy: 'amount',
        sortOrder: 'asc',
        amountCurrency: 'USD',
      });
      expect(asc.items.map((i) => i.id)).toEqual([debit.id, eur.id, usd.id, btc.id, unpriced.id]);
    });

    it('refuses a target currency the operator does not display, before any rate lookup', async () => {
      const w = await seedWallet();
      await seedTx(w.id);
      const rateReader = rates({});
      const svc = makeService(rateReader);

      await expect(
        svc.getTransactions({
          userId: w.userId,
          ...page,
          sortBy: 'amount',
          amountCurrency: 'ZZZ',
        }),
      ).rejects.toBeInstanceOf(UnsupportedAmountCurrencyError);
      expect(rateReader.getRate).not.toHaveBeenCalled();
    });

    it('ignores amountCurrency unless the sort is by amount', async () => {
      const w = await seedWallet();
      await seedTx(w.id);
      const rateReader = rates({});

      await makeService(rateReader).getTransactions({
        userId: w.userId,
        ...page,
        amountCurrency: 'ZZZ',
      });

      expect(rateReader.getRate).not.toHaveBeenCalled();
    });
  });
});
