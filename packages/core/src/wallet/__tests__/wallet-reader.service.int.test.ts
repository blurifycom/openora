import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletReaderService } from '../adapters/wallet-reader.service.js';

// A fake pivot-rate reader: `prices` gives the USD value of one whole unit of a currency,
// `unpriced` names currencies that answer null (no quote).
function makeRates(prices: Record<string, string>, unpriced: string[] = []): ExchangeRateReader {
  return {
    getRate: vi.fn(async () => null),
    convert: vi.fn(async (amount: string, from: string, to: string) => {
      if (from === to) {
        return amount;
      }
      if (unpriced.includes(from)) {
        return null;
      }
      const price = prices[from];
      return price === undefined ? null : String(Number(amount) * Number(price));
    }),
  };
}

let db: TestDb;
let svc: WalletReaderService;

async function seedWallet() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  svc = new WalletReaderService({ drizzle: db.drizzle, pivotCurrency: 'USD' });
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletReaderService.findByProviderRef (real PG)', () => {
  it('returns null for an unknown (providerName, providerRefId) pair', async () => {
    expect(await svc.findByProviderRef('aggregator-x', 'unknown-ref')).toBeNull();
  });

  it('returns the tagged row, including its metadata blob, for a known pair', async () => {
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'bet',
      amount: '10',
      currency: 'USD',
      status: 'completed',
      direction: 'debit',
      rail: 'fiat',
      providerName: 'aggregator-x',
      providerRefId: 'ref-1',
      externalRoundId: 'round-1',
      metadata: JSON.stringify({ balance: '90.00' }),
    });

    const found = await svc.findByProviderRef('aggregator-x', 'ref-1');

    expect(found).toMatchObject({
      providerName: 'aggregator-x',
      providerRefId: 'ref-1',
      externalRoundId: 'round-1',
      currency: 'USD',
      status: 'completed',
      type: 'bet',
    });
    expect(Number(found?.amount)).toBe(10);
    expect(JSON.parse(found?.metadata ?? 'null')).toEqual({ balance: '90.00' });
  });

  it('stays unaffected by unrelated wallet activity that happens afterward', async () => {
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'bet',
      amount: '10',
      currency: 'USD',
      status: 'completed',
      direction: 'debit',
      rail: 'fiat',
      providerName: 'aggregator-x',
      providerRefId: 'ref-2',
      metadata: JSON.stringify({ balance: '90.00' }),
    });
    const original = await svc.findByProviderRef('aggregator-x', 'ref-2');

    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'win',
      amount: '50',
      currency: 'USD',
      status: 'completed',
      direction: 'credit',
      rail: 'fiat',
    });

    const replayed = await svc.findByProviderRef('aggregator-x', 'ref-2');
    expect(replayed).toEqual(original);
  });
});

describe('WalletReaderService.isFirstDeposit (real PG)', () => {
  it('is true for a player whose only completed deposit is this one', async () => {
    const w = await seedWallet();
    const [txn] = await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'deposit',
        amount: '50',
        currency: 'USD',
        status: 'completed',
        direction: 'credit',
        rail: 'fiat',
      })
      .returning();

    expect(await svc.isFirstDeposit(w.userId, txn?.id ?? '')).toBe(true);
  });

  it('stays true for the earlier deposit even when the later one was recorded and checked first', async () => {
    const w = await seedWallet();
    const [earlier] = await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'deposit',
        amount: '50',
        currency: 'USD',
        status: 'completed',
        direction: 'credit',
        rail: 'fiat',
      })
      .returning();
    const [later] = await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'deposit',
        amount: '100',
        currency: 'USD',
        status: 'completed',
        direction: 'credit',
        rail: 'fiat',
      })
      .returning();

    // A running-total comparison, computed after both rows exist, would say neither deposit is
    // first. Each transaction's own committed created_at settles it regardless of read order.
    expect(await svc.isFirstDeposit(w.userId, later?.id ?? '')).toBe(false);
    expect(await svc.isFirstDeposit(w.userId, earlier?.id ?? '')).toBe(true);
  });

  it('is false for an unknown or not-yet-completed transaction', async () => {
    const w = await seedWallet();
    expect(await svc.isFirstDeposit(w.userId, randomUUID())).toBe(false);
  });
});

describe('WalletReaderService.getBalance (real PG)', () => {
  it('returns a zero USD balance for a user with no wallet row', async () => {
    expect(await svc.getBalance(randomUUID())).toEqual({ balance: '0', currency: 'USD' });
  });

  it('reports the configured default currency for a user with no wallet row', async () => {
    const configured = new WalletReaderService({
      drizzle: db.drizzle,
      defaultCurrency: 'USDT',
      pivotCurrency: 'USD',
    });
    const userId = randomUUID();

    expect(await configured.getBalance(userId)).toEqual({ balance: '0', currency: 'USDT' });
    expect(await configured.getBalances(userId)).toEqual({
      activeCurrency: 'USDT',
      balances: [],
    });
  });

  it('keeps an existing wallet on its own active currency when a default is configured', async () => {
    const w = await seedWallet();
    const configured = new WalletReaderService({
      drizzle: db.drizzle,
      defaultCurrency: 'USDT',
      pivotCurrency: 'USD',
    });

    expect((await configured.getBalance(w.userId)).currency).toBe('USD');
  });

  it("returns the wallet's active-currency balance", async () => {
    const w = await seedWallet();
    await db.drizzle.db
      .insert(walletBalance)
      .values({ walletId: w.id, currency: 'USD', amount: '42.50' });

    const result = await svc.getBalance(w.userId);
    expect(Number(result.balance)).toBe(42.5);
    expect(result.currency).toBe('USD');
  });

  it('reflects a currency switch on the wallet row, not just the balance rows', async () => {
    const w = await seedWallet();
    await db.drizzle.db.insert(walletBalance).values([
      { walletId: w.id, currency: 'USD', amount: '10' },
      { walletId: w.id, currency: 'EUR', amount: '5' },
    ]);
    await db.drizzle.db.update(wallet).set({ currency: 'EUR' }).where(eq(wallet.id, w.id));

    const result = await svc.getBalance(w.userId);
    expect(Number(result.balance)).toBe(5);
    expect(result.currency).toBe('EUR');
  });
});

async function seedDeposit(walletId: string, amount: string, currency: string) {
  await db.drizzle.db.insert(walletTransaction).values({
    walletId,
    type: 'deposit',
    amount,
    currency,
    status: 'completed',
    direction: 'credit',
    rail: currency === 'USD' ? 'fiat' : 'crypto',
  });
}

describe('WalletReaderService.getLifetimeDeposit (real PG)', () => {
  it('sums deposits held in a single currency with no fx module wired', async () => {
    const w = await seedWallet();
    await seedDeposit(w.id, '10', 'USD');
    await seedDeposit(w.id, '5', 'USD');

    expect(Number(await svc.getLifetimeDeposit(w.userId))).toBe(15);
  });

  it('prices every currency into the pivot instead of summing raw amounts', async () => {
    const w = await seedWallet();
    await seedDeposit(w.id, '1', 'BTC');
    await seedDeposit(w.id, '20000', 'DOGE');
    const priced = new WalletReaderService({
      drizzle: db.drizzle,
      pivotCurrency: 'USD',
      exchangeRateReader: makeRates({ BTC: '60000', DOGE: '0.1' }),
    });

    // Raw would read 20001 (1 BTC + 20000 DOGE) - priced reads 60000 + 2000.
    expect(Number(await priced.getLifetimeDeposit(w.userId))).toBe(62000);
  });

  it('returns null, not a partial total, when a currency cannot be priced', async () => {
    const w = await seedWallet();
    await seedDeposit(w.id, '1', 'BTC');
    await seedDeposit(w.id, '1', 'DOGE');
    const partiallyPriced = new WalletReaderService({
      drizzle: db.drizzle,
      pivotCurrency: 'USD',
      exchangeRateReader: makeRates({ BTC: '60000' }, ['DOGE']),
    });

    expect(await partiallyPriced.getLifetimeDeposit(w.userId)).toBeNull();
  });
});
