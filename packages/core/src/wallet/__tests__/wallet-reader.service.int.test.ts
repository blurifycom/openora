import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
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

    // Unrelated activity on the same wallet in between - a replay must still resolve
    // the exact original response, not one reconstructed from current state.
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
