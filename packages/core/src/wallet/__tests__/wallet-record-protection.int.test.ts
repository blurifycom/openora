import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

async function seedWallet() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seed: no wallet'),
  );
}

async function seedLedgerRow(overrides: Partial<typeof walletTransaction.$inferInsert> = {}) {
  const w = await seedWallet();
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'withdrawal',
        amount: '10',
        currency: 'USD',
        status: 'pending',
        rail: 'fiat',
        ...overrides,
      })
      .returning(),
    new Error('seed: no ledger row'),
  );
}

// Drizzle wraps a driver error; the trigger's own message is on its cause.
const rejectedWith = async (query: PromiseLike<unknown>, message: RegExp) => {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { cause?: Error }).cause?.message).toMatch(message);
};

const update = (id: string, set: Partial<typeof walletTransaction.$inferInsert>) =>
  db.drizzle.db.update(walletTransaction).set(set).where(eq(walletTransaction.id, id));

describe('wallet_transaction record protection (real PG)', () => {
  it('rejects removing a ledger row', async () => {
    const row = await seedLedgerRow();

    await rejectedWith(
      db.drizzle.db.delete(walletTransaction).where(eq(walletTransaction.id, row.id)),
      /append-only/,
    );
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(1);
  });

  it.each([
    ['amount', { amount: '11' }],
    ['type', { type: 'deposit' as const }],
    ['currency', { currency: 'EUR' }],
    ['created_at', { createdAt: new Date('2001-01-01') }],
    ['fee', { fee: '1' }],
    ['idempotency key', { idempotencyKey: randomUUID() }],
  ])('rejects rewriting the %s of a ledger row', async (_name, set) => {
    const row = await seedLedgerRow();

    await rejectedWith(update(row.id, set), /append-only/);
  });

  it('lets settlement move the status and review columns', async () => {
    const row = await seedLedgerRow();

    await update(row.id, {
      status: 'completed',
      reviewedBy: randomUUID(),
      reviewedAt: new Date(),
      reviewReason: 'ok',
    });

    const [after] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, row.id));
    expect(after?.status).toBe('completed');
  });

  it('fills balanceAfter once, then freezes it, while provider references stay updatable', async () => {
    const row = await seedLedgerRow();

    await update(row.id, {
      providerName: 'psp',
      providerRefId: 'ref-1',
      txHash: '0xabc',
      balanceAfter: '90',
    });

    await rejectedWith(update(row.id, { balanceAfter: '1' }), /append-only/);
    await expect(update(row.id, { providerRefId: 'ref-2', txHash: '0xdef' })).resolves.toBeDefined();
  });

  it('passes an update that matches no row', async () => {
    await seedLedgerRow();

    await expect(update(randomUUID(), { amount: '99' })).resolves.toBeDefined();
  });

  it('still allows TRUNCATE for test and seed cleanup', async () => {
    await seedLedgerRow();

    await db.drizzle.db.execute(sql`TRUNCATE ${walletTransaction}`);

    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
  });
});

describe('wallet_balance non-negative guard (real PG)', () => {
  it('rejects a negative balance', async () => {
    const w = await seedWallet();

    await rejectedWith(
      db.drizzle.db
        .insert(walletBalance)
        .values({ walletId: w.id, currency: 'USD', amount: '-0.01' }),
      /wallet_balance_amount_non_negative/,
    );
  });
});
