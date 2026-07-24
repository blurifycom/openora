import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

let db: TestDb;

const svc = new WalletCommandsService();

async function seedWallet(overrides: Partial<typeof wallet.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), balance: '0', currency: 'USD', ...overrides })
    .returning();
  return row!;
}

async function balanceOf(userId: string) {
  const [row] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
  return Number(row?.balance);
}

async function txRows(walletId: string) {
  return db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
}

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

describe('WalletCommandsService.debit (real PG)', () => {
  it('debits the balance and writes a completed bet ledger row', async () => {
    const w = await seedWallet({ balance: '100' });

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' });

    expect(res.ok).toBe(true);
    expect(Number((res as { newBalance: string }).newBalance)).toBe(90);
    const rows = await txRows(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      walletId: w.id,
      type: 'bet',
      status: 'completed',
      rail: 'fiat',
    });
    expect(Number(rows[0]?.amount)).toBe(10);
  });

  it('loss writes a 0-amount informational row and never touches the balance', async () => {
    const w = await seedWallet({ balance: '100' });

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '0', type: 'loss' });

    expect(res).toMatchObject({ ok: true });
    expect(Number((res as { newBalance: string }).newBalance)).toBe(100);
    expect(await balanceOf(w.userId)).toBe(100);
    const rows = await txRows(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'loss', status: 'completed' });
    expect(Number(rows[0]?.amount)).toBe(0);
  });

  it('rejects a non-positive amount for a real-money debit', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.debit(db.drizzle.db, { userId: w.userId, amount: '0', type: 'bet' }),
    ).rejects.toThrow(/positive/);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('fails with the shortfall and leaves the balance untouched when funds are insufficient', async () => {
    const w = await seedWallet({ balance: '5' });

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' });

    expect(res.ok).toBe(false);
    expect(Number((res as { available: string }).available)).toBe(5);
    expect(await txRows(w.id)).toHaveLength(0);
    expect(await balanceOf(w.userId)).toBe(5);
  });

  it('rolls the debit back when the caller transaction later throws', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        const result = await svc.debit(tx, { userId: w.userId, amount: '40', type: 'bet' });
        expect(result.ok).toBe(true);
        throw new Error('caller failed after the debit');
      }),
    ).rejects.toThrow('caller failed after the debit');

    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });
});

describe('WalletCommandsService.credit (real PG)', () => {
  it('increases the balance and writes a completed win ledger row', async () => {
    const w = await seedWallet({ balance: '50' });

    const res = await svc.credit(db.drizzle.db, { userId: w.userId, amount: '20', type: 'win' });

    expect(res.ok).toBe(true);
    expect(Number((res as { newBalance: string }).newBalance)).toBe(70);
    const rows = await txRows(w.id);
    expect(rows[0]).toMatchObject({
      walletId: w.id,
      type: 'win',
      status: 'completed',
      rail: 'fiat',
    });
  });

  it('returns the exact decimal newBalance from SQL numeric arithmetic, with no float drift', async () => {
    const w = await seedWallet({ balance: '0.1' });

    const res = await svc.credit(db.drizzle.db, { userId: w.userId, amount: '0.2', type: 'win' });

    expect(res.ok).toBe(true);
    expect(Number((res as { newBalance: string }).newBalance)).toBe(0.3);
  });

  it('fails closed on a missing wallet rather than creating one', async () => {
    const userId = randomUUID();

    const res = await svc.credit(db.drizzle.db, { userId, amount: '20', type: 'win' });

    expect(res).toEqual({ ok: false, reason: 'wallet not found' });
    const [row] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
    expect(row).toBeUndefined();
  });

  it('rejects a non-positive credit', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.credit(db.drizzle.db, { userId: w.userId, amount: '0', type: 'win' }),
    ).rejects.toThrow(/positive/);
  });
});

describe('WalletCommandsService ledger sequence (real PG)', () => {
  it('nets a deposit-like credit, a bet debit, and a win credit into one running balance', async () => {
    const w = await seedWallet({ balance: '0' });

    await svc.credit(db.drizzle.db, { userId: w.userId, amount: '100', type: 'deposit' });
    await svc.debit(db.drizzle.db, { userId: w.userId, amount: '30', type: 'bet' });
    await svc.credit(db.drizzle.db, { userId: w.userId, amount: '60', type: 'win' });

    expect(await balanceOf(w.userId)).toBe(130);
    const rows = await txRows(w.id);
    expect(rows.map((r) => r.type).sort()).toEqual(['bet', 'deposit', 'win']);
  });
});
