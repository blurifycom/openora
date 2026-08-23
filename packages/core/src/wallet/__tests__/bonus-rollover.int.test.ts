import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PaymentAdapter, PlayEligibilityPort } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeAuditWriter,
  makeIdentityReader,
  makePaymentProviderRegistry,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletBonusCredit,
  walletBonusRolloverConfig,
} from '../schema/index.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';
import {
  WalletService,
  BonusRolloverLockedError,
  BonusRolloverConfigNotFoundError,
  InsufficientBalanceError,
} from '../service/wallet.service.js';

let db: TestDb;

const unrestricted = mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(false) });

async function seedWallet({
  balance = '0',
  currency = 'USD',
  ...overrides
}: Partial<typeof wallet.$inferInsert> & { balance?: string } = {}) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency, ...overrides })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

async function insertCredit(
  w: { id: string; userId: string; currency: string },
  overrides: Partial<typeof walletBonusCredit.$inferInsert> = {},
) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(walletBonusCredit)
      .values({
        walletId: w.id,
        userId: w.userId,
        currency: w.currency,
        sourceType: 'gift',
        creditedAmount: '0',
        rolloverMultiplier: '1',
        rolloverRequired: '0',
        rolloverProgress: '0',
        status: 'active',
        ...overrides,
      })
      .returning(),
    new Error('insertCredit: query returned no row'),
  );
  return row;
}

async function creditsFor(userId: string) {
  return db.drizzle.db
    .select()
    .from(walletBonusCredit)
    .where(eq(walletBonusCredit.userId, userId))
    .orderBy(walletBonusCredit.createdAt);
}

function makeWalletService(audit = makeAuditWriter()) {
  return {
    svc: new WalletService({
      drizzle: db.drizzle,
      events: makeEventBus(),
      payment: mock<PaymentAdapter>({ processDeposit: vi.fn(), processWithdrawal: vi.fn() }),
      paymentProviders: makePaymentProviderRegistry(),
      identityReader: makeIdentityReader(),
      audit,
    }),
    audit,
  };
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletBonusCredit}, ${walletBonusRolloverConfig}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletCommandsService bonus credit creation on gift/rain (real PG)', () => {
  it('creates an active credit with rolloverRequired = creditedAmount * multiplier, and audits it', async () => {
    await db.drizzle.db
      .insert(walletBonusRolloverConfig)
      .values({ singletonKey: 'global', multiplier: '2' });
    const w = await seedWallet({ balance: '0' });
    const audit = makeAuditWriter();
    const svc = new WalletCommandsService(unrestricted, audit);

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      type: 'gift',
    });

    expect(res.ok).toBe(true);
    const credits = await creditsFor(w.userId);
    expect(credits).toHaveLength(1);
    const credit = credits[0]!;
    expect(credit).toMatchObject({
      walletId: w.id,
      currency: 'USD',
      sourceType: 'gift',
      status: 'active',
    });
    expect(Number(credit.creditedAmount)).toBe(50);
    expect(Number(credit.rolloverMultiplier)).toBe(2);
    expect(Number(credit.rolloverRequired)).toBe(100);
    expect(Number(credit.rolloverProgress)).toBe(0);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.bonus_credit.created',
        resourceType: 'wallet_bonus_credit',
        resourceId: credit.id,
      }),
    );
  });

  it('falls back to a 1x multiplier without throwing when the config row is missing', async () => {
    const w = await seedWallet({ balance: '0' });
    const svc = new WalletCommandsService(unrestricted, makeAuditWriter());

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '25',
      currency: 'USD',
      type: 'rain',
    });

    expect(res.ok).toBe(true);
    const credits = await creditsFor(w.userId);
    expect(Number(credits[0]!.rolloverMultiplier)).toBe(1);
    expect(Number(credits[0]!.rolloverRequired)).toBe(25);
  });

  it('never creates a bonus credit for a non gift/rain credit type', async () => {
    await db.drizzle.db
      .insert(walletBonusRolloverConfig)
      .values({ singletonKey: 'global', multiplier: '2' });
    const w = await seedWallet({ balance: '0' });
    const svc = new WalletCommandsService(unrestricted, makeAuditWriter());

    await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      type: 'win',
    });

    expect(await creditsFor(w.userId)).toHaveLength(0);
  });
});

describe('WalletCommandsService bonus rollover progress waterfall (real PG)', () => {
  it('drains the oldest active credit first, caps at rolloverRequired, and cascades leftover', async () => {
    const w = await seedWallet({ balance: '1000' });
    const older = await insertCredit(w, {
      creditedAmount: '30',
      rolloverRequired: '30',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await insertCredit(w, {
      creditedAmount: '50',
      rolloverRequired: '50',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const svc = new WalletCommandsService(unrestricted, makeAuditWriter());

    const res1 = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '40', type: 'bet' });
    if (!res1.ok) {
      throw new Error('expected res1.ok');
    }
    expect(res1.completedBonusCredits).toEqual([
      { id: older.id, currency: 'USD', creditedAmount: older.creditedAmount },
    ]);

    let rows = await creditsFor(w.userId);
    expect(rows.find((r) => r.id === older.id)).toMatchObject({ status: 'completed' });
    expect(Number(rows.find((r) => r.id === older.id)!.rolloverProgress)).toBe(30);
    expect(rows.find((r) => r.id === newer.id)).toMatchObject({ status: 'active' });
    expect(Number(rows.find((r) => r.id === newer.id)!.rolloverProgress)).toBe(10);

    const res2 = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '30', type: 'bet' });
    if (!res2.ok) {
      throw new Error('expected res2.ok');
    }
    expect(res2.completedBonusCredits).toEqual([]);
    rows = await creditsFor(w.userId);
    expect(rows.find((r) => r.id === newer.id)).toMatchObject({ status: 'active' });
    expect(Number(rows.find((r) => r.id === newer.id)!.rolloverProgress)).toBe(40);

    const res3 = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '20', type: 'bet' });
    if (!res3.ok) {
      throw new Error('expected res3.ok');
    }
    expect(res3.completedBonusCredits).toEqual([
      { id: newer.id, currency: 'USD', creditedAmount: newer.creditedAmount },
    ]);
    rows = await creditsFor(w.userId);
    const finalNewer = rows.find((r) => r.id === newer.id)!;
    expect(finalNewer.status).toBe('completed');
    expect(Number(finalNewer.rolloverProgress)).toBe(50);
    expect(finalNewer.completedAt).toBeInstanceOf(Date);
  });

  it('audits each completion with its own wallet.bonus_credit.completed record', async () => {
    const w = await seedWallet({ balance: '1000' });
    const credit = await insertCredit(w, { creditedAmount: '10', rolloverRequired: '10' });
    const audit = makeAuditWriter();
    const svc = new WalletCommandsService(unrestricted, audit);

    await svc.debit(db.drizzle.db, { userId: w.userId, amount: '10', type: 'bet' });

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.bonus_credit.completed',
        resourceType: 'wallet_bonus_credit',
        resourceId: credit.id,
        before: { status: 'active', rolloverProgress: expect.any(String) },
        after: {
          userId: w.userId,
          currency: 'USD',
          creditedAmount: '10.000000000000000000',
          rolloverRequired: '10.000000000000000000',
          rolloverProgress: '10.000000000000000000',
          status: 'completed',
        },
      }),
    );
  });

  it('leaves an already-completed credit and a different-currency credit untouched', async () => {
    const w = await seedWallet({ balance: '1000', currency: 'USD' });
    const alreadyDone = await insertCredit(w, {
      creditedAmount: '10',
      rolloverRequired: '10',
      rolloverProgress: '10',
      status: 'completed',
    });
    const otherCurrency = await insertCredit(w, {
      currency: 'EUR',
      creditedAmount: '30',
      rolloverRequired: '30',
    });
    const svc = new WalletCommandsService(unrestricted, makeAuditWriter());

    const res = await svc.debit(db.drizzle.db, { userId: w.userId, amount: '30', type: 'bet' });
    if (!res.ok) {
      throw new Error('expected res.ok');
    }
    expect(res.completedBonusCredits).toEqual([]);

    const [done] = await db.drizzle.db
      .select()
      .from(walletBonusCredit)
      .where(eq(walletBonusCredit.id, alreadyDone.id));
    expect(Number(done!.rolloverProgress)).toBe(10);
    const [eur] = await db.drizzle.db
      .select()
      .from(walletBonusCredit)
      .where(eq(walletBonusCredit.id, otherCurrency.id));
    expect(Number(eur!.rolloverProgress)).toBe(0);
  });

  it('does not apply rollover progress for a non-bet debit type', async () => {
    const w = await seedWallet({ balance: '1000' });
    const credit = await insertCredit(w, { creditedAmount: '10', rolloverRequired: '10' });
    const svc = new WalletCommandsService(unrestricted, makeAuditWriter());

    const res = await svc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      type: 'win',
    });
    expect(res.ok).toBe(true);

    const [row] = await db.drizzle.db
      .select()
      .from(walletBonusCredit)
      .where(eq(walletBonusCredit.id, credit.id));
    expect(Number(row!.rolloverProgress)).toBe(0);
  });
});

describe('WalletService.withdraw with an active bonus rollover lock (real PG)', () => {
  it('blocks a withdrawal once the requested amount exceeds the withdrawable (unlocked) balance', async () => {
    const w = await seedWallet({ balance: '100' });
    await insertCredit(w, {
      creditedAmount: '100',
      rolloverRequired: '100',
      rolloverProgress: '20',
    });
    const { svc } = makeWalletService();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'USD', ip: null, userAgent: null }),
    ).rejects.toBeInstanceOf(BonusRolloverLockedError);

    const [bal] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(Number(bal!.amount)).toBe(100);
  });

  it('allows a withdrawal within the unlocked portion and debits exactly that amount', async () => {
    const w = await seedWallet({ balance: '100' });
    await insertCredit(w, {
      creditedAmount: '100',
      rolloverRequired: '100',
      rolloverProgress: '20',
    });
    const { svc } = makeWalletService();

    const res = await svc.withdraw({
      userId: w.userId,
      amount: '20',
      currency: 'USD',
      ip: null,
      userAgent: null,
    });

    expect(res.status).toBe('pending');
    const [bal] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(Number(bal!.amount)).toBe(80);
  });

  it('allows a full-balance withdrawal once the bonus credit has completed', async () => {
    const w = await seedWallet({ balance: '100' });
    await insertCredit(w, {
      creditedAmount: '100',
      rolloverRequired: '100',
      rolloverProgress: '100',
      status: 'completed',
    });
    const { svc } = makeWalletService();

    const res = await svc.withdraw({
      userId: w.userId,
      amount: '100',
      currency: 'USD',
      ip: null,
      userAgent: null,
    });

    expect(res.status).toBe('pending');
    const [bal] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(Number(bal!.amount)).toBe(0);
  });

  it('still reports InsufficientBalanceError (not the bonus-lock error) when the raw balance itself is short', async () => {
    const w = await seedWallet({ balance: '10' });
    const { svc } = makeWalletService();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'USD', ip: null, userAgent: null }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});

describe('WalletService bonus rollover config admin (real PG)', () => {
  it('fails closed (NotFound) on GET when unseeded', async () => {
    const { svc } = makeWalletService();

    await expect(svc.getBonusRolloverConfig()).rejects.toBeInstanceOf(
      BonusRolloverConfigNotFoundError,
    );
    expect(await svc.getBonusRolloverConfigOrNull()).toBeNull();
  });

  it('self-heals a missing singleton row on first SET and audits a null-before change', async () => {
    const { svc, audit } = makeWalletService();
    const adminId = randomUUID();

    const config = await svc.setBonusRolloverConfig(adminId, { multiplier: '3' }, NO_CLIENT_META);

    expect(Number(config.multiplier)).toBe(3);
    expect(await svc.getBonusRolloverConfig()).toMatchObject({ id: config.id });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.bonus_rollover_config.set',
        resourceType: 'bonus_rollover_config',
        before: null,
        after: { multiplier: config.multiplier },
      }),
    );
  });

  it('updates the existing singleton row (one row total) and audits a before/after diff', async () => {
    await db.drizzle.db
      .insert(walletBonusRolloverConfig)
      .values({ singletonKey: 'global', multiplier: '1' });
    const { svc, audit } = makeWalletService();
    const adminId = randomUUID();

    const updated = await svc.setBonusRolloverConfig(adminId, { multiplier: '2' }, NO_CLIENT_META);

    expect(Number(updated.multiplier)).toBe(2);
    expect(await db.drizzle.db.select().from(walletBonusRolloverConfig)).toHaveLength(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.bonus_rollover_config.set',
        before: expect.objectContaining({ multiplier: expect.any(String) }),
        after: { multiplier: updated.multiplier },
      }),
    );
  });

  it('does not retroactively change the multiplier already snapshotted on an existing bonus credit', async () => {
    await db.drizzle.db
      .insert(walletBonusRolloverConfig)
      .values({ singletonKey: 'global', multiplier: '1' });
    const w = await seedWallet({ balance: '0' });
    const commandsSvc = new WalletCommandsService(unrestricted, makeAuditWriter());
    await commandsSvc.credit(db.drizzle.db, {
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      type: 'gift',
    });
    const { svc } = makeWalletService();

    await svc.setBonusRolloverConfig(randomUUID(), { multiplier: '5' }, NO_CLIENT_META);

    const [credit] = await creditsFor(w.userId);
    expect(Number(credit!.rolloverMultiplier)).toBe(1);
    expect(Number(credit!.rolloverRequired)).toBe(10);
  });
});
