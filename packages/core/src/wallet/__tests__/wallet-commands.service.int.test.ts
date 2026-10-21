import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow, type DrizzleTx } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  BonusGrantCommands,
  BonusWageringCommands,
  PlayEligibilityPort,
  RgLimitsPort,
} from '@openora/core/contracts';
import { createTestDb, waitForRowLockWaiter, type TestDb } from '@openora/core/testing';
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
    const gated = new WalletCommandsService(eligibility(false), audit, {
      rgLimits: refusingLimits(),
    });

    await expect(
      gated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).rejects.toMatchObject({
      name: 'RgLimitExceededError',
      data: { reason: 'wager_limit_exceeded', limitType: 'wager', period: 'daily', limit: '50' },
    });
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('lets a bet within the limit through', async () => {
    const w = await seedWallet({ balance: '100' });
    const gated = new WalletCommandsService(eligibility(false), audit, {
      rgLimits: allowingLimits(),
    });

    await expect(
      gated.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' }),
    ).resolves.toMatchObject({ ok: true });
    expect(await balanceOf(w.userId)).toBe(90);
  });

  it('never gates a win or a loss - they settle a round that was already staked', async () => {
    const w = await seedWallet({ balance: '100' });
    const limits = refusingLimits();
    const gated = new WalletCommandsService(eligibility(false), audit, { rgLimits: limits });

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

  it('serializes concurrent bets so they cannot jointly pass the same limit', async () => {
    const w = await seedWallet({ balance: '1000' });
    let staked = 0;
    const limits = mock<RgLimitsPort>({
      checkDeposit: vi.fn(),
      checkWager: vi.fn(async (_tx: unknown, _userId: string, amount: string) => {
        await new Promise((r) => setTimeout(r, 10));
        if (staked + Number(amount) > 100) {
          return {
            allowed: false as const,
            limitType: 'wager' as const,
            period: 'daily' as const,
            limit: '100',
            used: String(staked),
          };
        }
        staked += Number(amount);
        return { allowed: true as const };
      }),
    });
    const gated = new WalletCommandsService(eligibility(false), audit, { rgLimits: limits });

    const results = await Promise.allSettled([
      db.drizzle.db.transaction((tx) =>
        gated.debit(tx, { userId: w.userId, amount: '60', type: 'bet' }),
      ),
      db.drizzle.db.transaction((tx) =>
        gated.debit(tx, { userId: w.userId, amount: '60', type: 'bet' }),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(940);
  });

  it('refuses on the exclusion before it even asks about the amount', async () => {
    const w = await seedWallet({ balance: '100' });
    const limits = allowingLimits();
    const gated = new WalletCommandsService(eligibility(true), audit, { rgLimits: limits });

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

  it('opens the wallet and the balance for a player who has none when allowNewWallet is set', async () => {
    const userId = randomUUID();

    const res = await svc.credit(db.drizzle.db, {
      userId,
      amount: '20',
      currency: 'USDT',
      type: 'cashback',
      allowNewCurrency: true,
      allowNewWallet: true,
    });

    expect(res).toMatchObject({ ok: true, moved: true });
    expect(await balanceOf(userId)).toBe(20);
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

describe('WalletCommandsService.credit gift/rain grant terms (real PG)', () => {
  it('forwards explicit terms to the bonus grant', async () => {
    const w = await seedWallet({ balance: '0' });
    const grant = vi.fn().mockResolvedValue({ ok: true, grantId: randomUUID(), created: true });
    const svcWithGrants = new WalletCommandsService(eligibility(false), audit, {
      bonusGrants: mock<BonusGrantCommands>({ grant }),
    });

    await svcWithGrants.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'gift',
      providerRef: { providerName: 'social-transfers', providerRefId: randomUUID() },
      terms: { wageringMultiplier: '3', expiryDays: 7 },
    });

    expect(grant).toHaveBeenCalledWith(
      db.drizzle.db,
      expect.objectContaining({ terms: { wageringMultiplier: '3', expiryDays: 7 } }),
    );
  });

  it('omits terms and leaves the bonus module to fall back to its own default', async () => {
    const w = await seedWallet({ balance: '0' });
    const grant = vi.fn().mockResolvedValue({ ok: true, grantId: randomUUID(), created: true });
    const svcWithGrants = new WalletCommandsService(eligibility(false), audit, {
      bonusGrants: mock<BonusGrantCommands>({ grant }),
    });

    await svcWithGrants.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'rain',
      providerRef: { providerName: 'social-transfers', providerRefId: randomUUID() },
    });

    expect(grant).toHaveBeenCalledWith(
      db.drizzle.db,
      expect.objectContaining({ terms: undefined }),
    );
  });

  it("does not wait on a recipient's wallet another transaction holds", async () => {
    const w = await seedWallet({ balance: '50' });
    const grant = vi.fn().mockResolvedValue({ ok: true, grantId: randomUUID(), created: true });
    const svcWithGrants = new WalletCommandsService(eligibility(false), audit, {
      bonusGrants: mock<BonusGrantCommands>({ grant }),
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let debited = () => {};
    const holding = new Promise<void>((resolve) => {
      debited = resolve;
    });
    const betting = db.drizzle.db.transaction(async (tx) => {
      await svcWithGrants.debit(tx, { userId: w.userId, amount: '10', type: 'bet' });
      debited();
      await released;
    });
    await holding;

    const raining = db.drizzle.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      return svcWithGrants.credit(tx, {
        userId: w.userId,
        amount: '5',
        currency: 'USD',
        type: 'rain',
        providerRef: { providerName: 'social-transfers', providerRefId: randomUUID() },
      });
    });
    const outcome = await raining.finally(release);
    await betting;

    expect(outcome.ok).toBe(true);
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

describe('WalletCommandsService providerRef tagging (real PG)', () => {
  it('debit writes providerName/providerRefId/externalRoundId/metadata exactly as passed', async () => {
    const w = await seedWallet({ balance: '100' });

    await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      type: 'bet',
      providerRef: {
        providerName: 'aggregator-x',
        providerRefId: 'ref-debit-1',
        externalRoundId: 'round-1',
        responseSnapshot: { balance: '90.00', currency: 'USD' },
      },
    });

    const rows = await txRows(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerName: 'aggregator-x',
      providerRefId: 'ref-debit-1',
      externalRoundId: 'round-1',
    });
    expect(JSON.parse(rows[0]?.metadata ?? 'null')).toEqual({ balance: '90.00', currency: 'USD' });
  });

  it('credit writes providerName/providerRefId/externalRoundId/metadata exactly as passed', async () => {
    const w = await seedWallet({ balance: '50' });

    await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator-x',
        providerRefId: 'ref-credit-1',
        externalRoundId: 'round-2',
        responseSnapshot: { balance: '70.00' },
      },
    });

    const rows = await txRows(w.id);
    expect(rows[0]).toMatchObject({
      providerName: 'aggregator-x',
      providerRefId: 'ref-credit-1',
      externalRoundId: 'round-2',
    });
    expect(JSON.parse(rows[0]?.metadata ?? 'null')).toEqual({ balance: '70.00' });
  });

  it('the loss branch tags its ledger row with a passed providerRef', async () => {
    const w = await seedWallet({ balance: '100' });

    await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '0',
      type: 'loss',
      providerRef: { providerName: 'aggregator-x', providerRefId: 'ref-loss-1' },
    });

    const rows = await txRows(w.id);
    expect(rows[0]).toMatchObject({
      type: 'loss',
      providerName: 'aggregator-x',
      providerRefId: 'ref-loss-1',
    });
  });

  it('leaves providerName/providerRefId/externalRoundId/metadata null when no providerRef is passed', async () => {
    const w = await seedWallet({ balance: '100' });

    await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' });

    const rows = await txRows(w.id);
    expect(rows[0]).toMatchObject({
      providerName: null,
      providerRefId: null,
      externalRoundId: null,
      metadata: null,
    });
  });
});

describe('WalletCommandsService providerRef replay safety (real PG)', () => {
  it('debit does not double-debit a replayed (providerName, providerRefId)', async () => {
    const w = await seedWallet({ balance: '100' });
    const providerRef = { providerName: 'aggregator-x', providerRefId: 'ref-replay-debit' };

    const first = await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      type: 'bet',
      providerRef,
    });
    const second = await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      type: 'bet',
      providerRef,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(Number(first.ok && first.newBalance)).toBe(90);
    expect(Number(second.ok && second.newBalance)).toBe(90);
    expect(await balanceOf(w.userId)).toBe(90);
    expect(await txRows(w.id)).toHaveLength(1);
  });

  it('credit does not double-credit a replayed (providerName, providerRefId)', async () => {
    const w = await seedWallet({ balance: '50' });
    const providerRef = { providerName: 'aggregator-x', providerRefId: 'ref-replay-credit' };

    const first = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
      providerRef,
    });
    const second = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
      providerRef,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(Number(first.ok && first.newBalance)).toBe(70);
    expect(Number(second.ok && second.newBalance)).toBe(70);
    expect(await balanceOf(w.userId)).toBe(70);
    expect(await txRows(w.id)).toHaveLength(1);
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

describe('WalletCommandsService outcome moved/transactionId (real PG)', () => {
  // The caller (eg GamingService) reads `moved` to know whether to emit
  // wallet.balance.changed once its own transaction commits - see the class comment on
  // WalletCommandsService for why the port itself never emits that event.

  it('debit returns the ledger row id on a real bet', async () => {
    const w = await seedWallet({ balance: '100' });

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' });

    const rows = await txRows(w.id);
    expect(res).toMatchObject({ ok: true, moved: true, transactionId: rows[0]?.id });
  });

  it('credit returns the ledger row id on a real win', async () => {
    const w = await seedWallet({ balance: '50' });

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
    });

    const rows = await txRows(w.id);
    expect(res).toMatchObject({ ok: true, moved: true, transactionId: rows[0]?.id });
  });

  it('a 0-amount loss returns no transactionId - nothing moved', async () => {
    const w = await seedWallet({ balance: '100' });

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '0', type: 'loss' });

    expect(res).toEqual({
      ok: true,
      moved: false,
      newBalance: expect.any(String),
      currency: 'USD',
    });
  });

  it('a replayed debit (same providerRef) returns no transactionId on the replay', async () => {
    const w = await seedWallet({ balance: '100' });
    const providerRef = { providerName: 'aggregator-x', providerRefId: 'ref-evt-debit-1' };

    const first = await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      type: 'bet',
      providerRef,
    });
    const second = await svc.debit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      type: 'bet',
      providerRef,
    });

    expect(first).toMatchObject({ ok: true, moved: true, transactionId: expect.any(String) });
    expect(second).toMatchObject({ ok: true, moved: false });
    expect(second).not.toHaveProperty('transactionId');
  });

  it('a replayed credit (same providerRef) returns no transactionId on the replay', async () => {
    const w = await seedWallet({ balance: '50' });
    const providerRef = { providerName: 'aggregator-x', providerRefId: 'ref-evt-credit-1' };

    const first = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
      providerRef,
    });
    const second = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      type: 'win',
      providerRef,
    });

    expect(first).toMatchObject({ ok: true, moved: true, transactionId: expect.any(String) });
    expect(second).toMatchObject({ ok: true, moved: false });
    expect(second).not.toHaveProperty('transactionId');
  });
});

describe('WalletCommandsService.correctionDebit (real PG)', () => {
  const reversal = (userId: string, amount: string, ref = randomUUID()) =>
    svc.correctionDebit(db.drizzle.db, {
      userId,
      amount,
      currency: 'USD',
      type: 'win_reversal',
      providerRef: { providerName: 'provider', providerRefId: ref, externalRoundId: 'bet-1' },
    });

  it('collects the whole amount when the balance covers it', async () => {
    const w = await seedWallet({ balance: '100' });

    const outcome = await reversal(w.userId, '30');

    expect(outcome.moved).toBe(true);
    expect(Number(outcome.newBalance)).toBe(70);
    expect(Number(outcome.collected)).toBe(30);
    expect(Number(outcome.shortfall)).toBe(0);
    const [row] = await txRows(w.id);
    expect(row).toMatchObject({
      type: 'win_reversal',
      direction: 'debit',
      status: 'completed',
      externalRoundId: 'bet-1',
    });
    expect(Number(row?.amount)).toBe(30);
  });

  it('collects what the balance holds, reports the rest, and records only the collected part', async () => {
    const w = await seedWallet({ balance: '20' });

    const outcome = await reversal(w.userId, '50');

    expect(outcome.moved).toBe(true);
    expect(Number(outcome.collected)).toBe(20);
    expect(Number(outcome.shortfall)).toBe(30);
    expect(await balanceOf(w.userId)).toBe(0);
    const rows = await txRows(w.id);
    expect(rows.map((r) => Number(r.amount))).toEqual([20]);
  });

  it('writes no ledger row when the balance is empty', async () => {
    const w = await seedWallet({ balance: '0' });

    const outcome = await reversal(w.userId, '50');

    expect(outcome).toMatchObject({ moved: false, collected: '0', shortfall: '50' });
    expect(Number(outcome.newBalance)).toBe(0);
    expect(await txRows(w.id)).toEqual([]);
  });

  it('reports a player without a wallet as owing the whole amount', async () => {
    const outcome = await reversal(randomUUID(), '50');

    expect(outcome).toEqual({ moved: false, collected: '0', shortfall: '50', newBalance: '0' });
  });

  it('collects once for a replayed reference', async () => {
    const w = await seedWallet({ balance: '20' });
    const ref = randomUUID();
    await reversal(w.userId, '50', ref);
    await db.drizzle.db
      .update(walletBalance)
      .set({ amount: '100' })
      .where(eq(walletBalance.walletId, w.id));

    const replay = await reversal(w.userId, '50', ref);

    expect(replay.moved).toBe(false);
    expect(Number(replay.collected)).toBe(20);
    expect(Number(replay.shortfall)).toBe(30);
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(1);
  });

  it('refuses a replay asking less than the first call collected', async () => {
    const w = await seedWallet({ balance: '40' });
    const ref = randomUUID();
    await reversal(w.userId, '50', ref);

    await expect(reversal(w.userId, '30', ref)).rejects.toMatchObject({
      name: 'WalletCorrectionRefConflictError',
    });
    expect(await balanceOf(w.userId)).toBe(0);
  });

  it('refuses a reference already used by another ledger move', async () => {
    const w = await seedWallet({ balance: '100' });
    const providerRef = { providerName: 'provider', providerRefId: randomUUID() };
    await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '25',
      currency: 'USD',
      type: 'win',
      providerRef,
    });

    await expect(reversal(w.userId, '25', providerRef.providerRefId)).rejects.toMatchObject({
      name: 'WalletCorrectionRefConflictError',
    });
    expect(await balanceOf(w.userId)).toBe(125);
  });

  it("refuses a re-stake reusing the original stake's reference", async () => {
    const w = await seedWallet({ balance: '100' });
    const providerRef = {
      providerName: 'provider',
      providerRefId: randomUUID(),
      externalRoundId: 'round-1',
    };
    await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet', providerRef });

    await expect(
      svc.correctionDebit(db.drizzle.db, {
        userId: w.userId,
        amount: '10',
        currency: 'USD',
        type: 'bet',
        providerRef,
      }),
    ).rejects.toMatchObject({ name: 'WalletCorrectionRefConflictError' });
    expect(await balanceOf(w.userId)).toBe(90);
  });

  it('puts the balance back when another wallet takes the reference mid-correction', async () => {
    const owner = await seedWallet({ balance: '100' });
    const other = await seedWallet({ balance: '100' });
    const providerRefId = randomUUID();
    let commitOwner = () => {};
    const ownerMayCommit = new Promise<void>((resolve) => {
      commitOwner = resolve;
    });
    let ownerWrote = () => {};
    const ownerHasRef = new Promise<void>((resolve) => {
      ownerWrote = resolve;
    });
    const owning = db.drizzle.db.transaction(async (tx) => {
      await svc.correctionDebit(tx, {
        userId: owner.userId,
        amount: '10',
        currency: 'USD',
        type: 'win_reversal',
        providerRef: { providerName: 'provider', providerRefId, externalRoundId: 'round-1' },
      });
      ownerWrote();
      await ownerMayCommit;
    });
    await ownerHasRef;

    const colliding = db.drizzle.db.transaction(async (tx) => {
      const refused = await svc
        .correctionDebit(tx, {
          userId: other.userId,
          amount: '30',
          currency: 'USD',
          type: 'win_reversal',
          providerRef: { providerName: 'provider', providerRefId, externalRoundId: 'round-1' },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      return refused;
    });
    await waitForRowLockWaiter(db);
    commitOwner();
    await owning;

    expect(await colliding).toMatchObject({ name: 'WalletCorrectionRefConflictError' });
    expect(await balanceOf(other.userId)).toBe(100);
    expect(await txRows(other.id)).toHaveLength(0);
  });

  it.each([
    [
      'a correction',
      (tx: DrizzleTx, userId: string) =>
        svc.correctionDebit(tx, {
          userId,
          amount: '30',
          currency: 'USD',
          type: 'win_reversal',
          providerRef: {
            providerName: 'provider',
            providerRefId: randomUUID(),
            externalRoundId: 'round-1',
          },
        }),
      50,
    ],
    [
      'a withdrawal hold',
      (tx: DrizzleTx, userId: string) =>
        svc.placeWithdrawalHold(tx, { userId, source: 'provider', reason: 'debt' }),
      80,
    ],
  ] as const)(
    'lets a credit and %s share a transaction while another credit waits',
    async (_, follow, balance) => {
      const w = await seedWallet({ balance: '20' });
      let finish = () => {};
      const mayFinish = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let credited = () => {};
      const creditDone = new Promise<void>((resolve) => {
        credited = resolve;
      });
      const settling = db.drizzle.db.transaction(async (tx) => {
        await svc.credit(tx, {
          userId: w.userId,
          amount: '50',
          currency: 'USD',
          type: 'win',
          providerRef: { providerName: 'provider', providerRefId: randomUUID() },
        });
        credited();
        await mayFinish;
        await follow(tx, w.userId);
      });
      await creditDone;

      const paying = db.drizzle.db.transaction((tx) =>
        svc.credit(tx, {
          userId: w.userId,
          amount: '10',
          currency: 'USD',
          type: 'win',
          providerRef: { providerName: 'provider', providerRefId: randomUUID() },
        }),
      );
      await waitForRowLockWaiter(db);
      finish();

      await settling;
      expect((await paying).ok).toBe(true);
      expect(await balanceOf(w.userId)).toBe(balance);
    },
  );

  it('lets a credit and a correction share a transaction while another correction waits', async () => {
    const w = await seedWallet({ balance: '20' });
    const correct = (tx: DrizzleTx, amount: string) =>
      svc.correctionDebit(tx, {
        userId: w.userId,
        amount,
        currency: 'USD',
        type: 'win_reversal',
        providerRef: {
          providerName: 'provider',
          providerRefId: randomUUID(),
          externalRoundId: 'round-1',
        },
      });
    let finish = () => {};
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let credited = () => {};
    const creditDone = new Promise<void>((resolve) => {
      credited = resolve;
    });
    const settling = db.drizzle.db.transaction(async (tx) => {
      await svc.credit(tx, {
        userId: w.userId,
        amount: '50',
        currency: 'USD',
        type: 'win',
        providerRef: { providerName: 'provider', providerRefId: randomUUID() },
      });
      credited();
      await mayFinish;
      await correct(tx, '30');
    });
    await creditDone;

    const reversing = db.drizzle.db.transaction((tx) => correct(tx, '10'));
    await waitForRowLockWaiter(db);
    finish();

    await settling;
    expect((await reversing).collected).toBe('10');
    expect(await balanceOf(w.userId)).toBe(30);
  });

  it('never overdraws when two corrections race for one balance', async () => {
    const w = await seedWallet({ balance: '50' });

    const outcomes = await Promise.all([
      db.drizzle.db.transaction((tx) =>
        svc.correctionDebit(tx, {
          userId: w.userId,
          amount: '40',
          currency: 'USD',
          type: 'win_reversal',
          providerRef: {
            providerName: 'provider',
            providerRefId: randomUUID(),
            externalRoundId: 'round-1',
          },
        }),
      ),
      db.drizzle.db.transaction((tx) =>
        svc.correctionDebit(tx, {
          userId: w.userId,
          amount: '40',
          currency: 'USD',
          type: 'bet',
          providerRef: {
            providerName: 'provider',
            providerRefId: randomUUID(),
            externalRoundId: 'round-1',
          },
        }),
      ),
    ]);

    expect(outcomes.reduce((sum, o) => sum + Number(o.collected), 0)).toBe(50);
    expect(outcomes.reduce((sum, o) => sum + Number(o.shortfall), 0)).toBe(30);
    expect(await balanceOf(w.userId)).toBe(0);
    const ledger = await txRows(w.id);
    expect(ledger.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(50);
  });

  it('collects against the balance a concurrent balance writer leaves behind', async () => {
    const w = await seedWallet({ balance: '50' });
    let commitWriter = () => {};
    const writerMayCommit = new Promise<void>((resolve) => {
      commitWriter = resolve;
    });
    let writerUpdated = () => {};
    const updated = new Promise<void>((resolve) => {
      writerUpdated = resolve;
    });
    const writer = db.drizzle.db.transaction(async (tx) => {
      await tx.update(walletBalance).set({ amount: '10' }).where(eq(walletBalance.walletId, w.id));
      writerUpdated();
      await writerMayCommit;
    });
    await updated;

    const collecting = reversal(w.userId, '40');
    await waitForRowLockWaiter(db);
    commitWriter();
    await writer;
    const outcome = await collecting;

    expect(Number(outcome.collected)).toBe(10);
    expect(Number(outcome.shortfall)).toBe(30);
    expect(await balanceOf(w.userId)).toBe(0);
  });

  it('skips play eligibility, the wager limit and the bonus engine for a stake correction', async () => {
    const w = await seedWallet({ balance: '100' });
    const isRestricted = vi.fn().mockResolvedValue(true);
    const limits = refusingLimits();
    const wager = vi.fn();
    const gated = new WalletCommandsService(mock<PlayEligibilityPort>({ isRestricted }), audit, {
      rgLimits: limits,
      bonusWagering: mock<BonusWageringCommands>({ wager }),
    });

    const outcome = await gated.correctionDebit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      type: 'bet',
      providerRef: {
        providerName: 'provider',
        providerRefId: randomUUID(),
        externalRoundId: 'round-1',
      },
    });

    expect(outcome.moved).toBe(true);
    expect(isRestricted).not.toHaveBeenCalled();
    expect(limits.checkWager).not.toHaveBeenCalled();
    expect(wager).not.toHaveBeenCalled();
  });

  it('refuses any type other than a payout reversal or a stake', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.correctionDebit(db.drizzle.db, {
        userId: w.userId,
        amount: '10',
        currency: 'USD',
        // @ts-expect-error a withdrawal is not a correction
        type: 'withdrawal',
        providerRef: {
          providerName: 'provider',
          providerRefId: randomUUID(),
          externalRoundId: 'round-1',
        },
      }),
    ).rejects.toMatchObject({ name: 'WalletCorrectionTypeError' });
    expect(await balanceOf(w.userId)).toBe(100);
  });

  it('refuses a payout reversal through a plain debit, which skips the round id check', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.debit(db.drizzle.db, {
        userId: w.userId,
        amount: '10',
        type: 'win_reversal',
        providerRef: { providerName: 'provider', providerRefId: randomUUID() },
      }),
    ).rejects.toMatchObject({ name: 'WalletCorrectionTypeError' });
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('refuses a payout reversal through a credit, which would move GGR the wrong way', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.credit(db.drizzle.db, {
        userId: w.userId,
        amount: '10',
        currency: 'USD',
        type: 'win_reversal',
        providerRef: { providerName: 'provider', providerRefId: randomUUID() },
      }),
    ).rejects.toMatchObject({ name: 'WalletCorrectionTypeError' });
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });

  it('refuses a correction without a round id, which RG spend could not net', async () => {
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.correctionDebit(db.drizzle.db, {
        userId: w.userId,
        amount: '10',
        currency: 'USD',
        type: 'win_reversal',
        // @ts-expect-error a correction must name its round
        providerRef: { providerName: 'provider', providerRefId: randomUUID() },
      }),
    ).rejects.toMatchObject({ name: 'WalletCorrectionRoundError' });
    expect(await balanceOf(w.userId)).toBe(100);
    expect(await txRows(w.id)).toHaveLength(0);
  });
});
