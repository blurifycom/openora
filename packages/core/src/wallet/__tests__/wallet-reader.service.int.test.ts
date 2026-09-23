import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletReaderService } from '../adapters/wallet-reader.service.js';

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
  svc = new WalletReaderService(db.drizzle);
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
    const configured = new WalletReaderService(db.drizzle, 'USDT');
    const userId = randomUUID();

    expect(await configured.getBalance(userId)).toEqual({ balance: '0', currency: 'USDT' });
    expect(await configured.getBalances(userId)).toEqual({
      activeCurrency: 'USDT',
      balances: [],
    });
  });

  it('keeps an existing wallet on its own active currency when a default is configured', async () => {
    const w = await seedWallet();
    const configured = new WalletReaderService(db.drizzle, 'USDT');

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
