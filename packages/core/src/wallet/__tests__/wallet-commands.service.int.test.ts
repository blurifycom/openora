import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PlayEligibilityPort, RgLimitsPort } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeAuditWriter } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import {
  WalletCommandsService,
  WalletRgRestrictedError,
} from '../service/wallet-commands.service.js';

let db: TestDb;

const eligibility = (isRestricted: boolean) =>
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(isRestricted) });

const audit = makeAuditWriter();
const svc = new WalletCommandsService(eligibility(false), audit);

async function seedWallet({
  balance = '0',
  ...overrides
}: Partial<typeof wallet.$inferInsert> & { balance?: string } = {}) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD', ...overrides })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

async function balanceOf(userId: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  return Number(row?.amount ?? 0);
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

// The money dimension of RG: a bound gate that refuses, one that allows, and the absent
// port (an install without the compliance module).
const refusingLimits = () =>
  mock<RgLimitsPort>({
    checkDeposit: vi.fn(),
    checkWager: vi.fn().mockResolvedValue({
      allowed: false,
      limitType: 'wager',
      period: 'daily',
      limit: '50',
      used: '45',
    }),
  });
const allowingLimits = () =>
  mock<RgLimitsPort>({
    checkDeposit: vi.fn(),
    checkWager: vi.fn().mockResolvedValue({ allowed: true }),
  });

describe('WalletCommandsService wager-limit gate (real PG)', () => {
  it('refuses a bet over the limit without touching the ledger, and says why', async () => {
    const w = await seedWallet({ balance: '100' });
    const gated = new WalletCommandsService(eligibility(false), audit, undefined, refusingLimits());

    await expect(
      gated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).rejects.toMatchObject({
      name: 'WagerLimitExceededError',
      data: { limitType: 'wager', period: 'daily', limit: '50', used: '45' },
    });
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('lets a bet within the limit through', async () => {
    const w = await seedWallet({ balance: '100' });
    const gated = new WalletCommandsService(eligibility(false), audit, undefined, allowingLimits());

    await expect(
      gated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).resolves.toMatchObject({ ok: true });
    expect(await balanceOf(w.userId)).toBe(90);
  });

  it('never gates a win or a loss - they settle a round that was already staked', async () => {
    const w = await seedWallet({ balance: '100' });
    const limits = refusingLimits();
    const gated = new WalletCommandsService(eligibility(false), audit, undefined, limits);

    await gated.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      type: 'win',
    });
    await gated.debit(db.drizzle.db, { userId: w.userId, amount: '0', type: 'loss' });

    expect(limits.checkWager).not.toHaveBeenCalled();
  });

  it('passes bets through untouched when no gate is bound', async () => {
    const w = await seedWallet({ balance: '100' });
    const ungated = new WalletCommandsService(eligibility(false), audit);

    await expect(
      ungated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses on the exclusion before it even asks about the amount', async () => {
    const w = await seedWallet({ balance: '100' });
    const limits = allowingLimits();
    const gated = new WalletCommandsService(eligibility(true), audit, undefined, limits);

    await expect(
      gated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).rejects.toBeInstanceOf(WalletRgRestrictedError);
    expect(limits.checkWager).not.toHaveBeenCalled();
  });
});

describe('WalletCommandsService responsible-gambling gate (real PG)', () => {
  it('refuses a bet debit for a restricted player without touching the ledger', async () => {
    const w = await seedWallet({ balance: '100' });
    const restricted = new WalletCommandsService(eligibility(true), audit);

    await expect(
      restricted.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).rejects.toBeInstanceOf(WalletRgRestrictedError);
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('leaves a non-bet debit unaffected for a restricted player', async () => {
    const w = await seedWallet({ balance: '100' });
    const restricted = new WalletCommandsService(eligibility(true), audit);

    const res = await restricted.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '0',
      type: 'loss',
    });

    expect(res).toMatchObject({ ok: true });
    expect(Number((res as { newBalance: string }).newBalance)).toBe(100);
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(1);
    expect((await txRows(w.id))[0]).toMatchObject({ type: 'loss' });
  });
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

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
    });

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

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '0.2',
      currency: 'USD',
      type: 'win',
    });

    expect(res.ok).toBe(true);
    expect(Number((res as { newBalance: string }).newBalance)).toBe(0.3);
  });

  it('fails closed on a missing wallet rather than creating one', async () => {
    const userId = randomUUID();

    const res = await svc.credit(db.drizzle.db, {
      userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
    });

    expect(res).toEqual({ ok: false, reason: 'wallet not found' });
    const rows = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
    expect(rows).toEqual([]);
  });

  it('rejects a non-positive credit', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.credit(db.drizzle.db, {
        userId: w.userId,
        amount: '0',
        currency: 'USD',
        type: 'win',
      }),
    ).rejects.toThrow(/positive/);
  });
});

describe('WalletCommandsService ledger direction (real PG)', () => {
  // gift/rain/tip write the SAME `type` for both legs of a transfer - direction is the
  // only column that tells the sender's debit apart from the recipient's credit.
  it('records opposite directions for the sender debit and recipient credit legs of a tip', async () => {
    const sender = await seedWallet({ balance: '100' });
    const recipient = await seedWallet({ balance: '0' });

    await svc.debit(db.drizzle.db, { userId: sender.userId, amount: '10', type: 'tip' });
    await svc.credit(db.drizzle.db, {
      userId: recipient.userId,
      amount: '10',
      currency: 'USD',
      type: 'tip',
    });

    const senderRows = await txRows(sender.id);
    const recipientRows = await txRows(recipient.id);
    expect(senderRows[0]).toMatchObject({ type: 'tip', direction: 'debit' });
    expect(recipientRows[0]).toMatchObject({ type: 'tip', direction: 'credit' });
  });
});

describe('WalletCommandsService ledger sequence (real PG)', () => {
  it('nets a deposit-like credit, a bet debit, and a win credit into one running balance', async () => {
    const w = await seedWallet({ balance: '0' });

    await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '100',
      currency: 'USD',
      type: 'deposit',
    });
    await svc.debit(db.drizzle.db, { userId: w.userId, amount: '30', type: 'bet' });
    await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '60',
      currency: 'USD',
      type: 'win',
    });

    expect(await balanceOf(w.userId)).toBe(130);
    const rows = await txRows(w.id);
    expect(rows.map((r) => r.type).sort()).toEqual(['bet', 'deposit', 'win']);
  });
});
