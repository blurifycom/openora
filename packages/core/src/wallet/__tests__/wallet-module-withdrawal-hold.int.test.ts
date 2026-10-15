import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import {
  type AdminPlayerSummary,
  type AdminUserDirectory,
  type PaymentAdapter,
  type PlatformConfig,
  type PlayEligibilityPort,
  WalletHoldWithoutWalletError,
} from '@openora/core/contracts';
import { createTestDb, waitForRowLockWaiter, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletAutoWithdrawalConfig,
  walletBalance,
  walletTransaction,
  walletWithdrawalHold,
} from '../schema/index.js';
import {
  WalletService,
  WithdrawalHeldError,
  type WalletServiceDeps,
} from '../service/wallet.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

let db: TestDb;

const commands = new WalletCommandsService(
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(false) }),
  makeAuditWriter(),
);

function makeService(overrides: Partial<WalletServiceDeps> = {}) {
  const psp = {
    processDeposit: vi.fn(),
    processWithdrawal: vi.fn(async () => ({
      externalId: randomUUID(),
      status: 'completed' as const,
    })),
  };
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>(psp),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    ...overrides,
  });
  return { svc, psp };
}

function makeAutoService(overrides: Partial<WalletServiceDeps> = {}) {
  return makeService({
    directory: mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) =>
          mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'approved' }),
        ),
      ),
    }),
    platformConfig: mock<PlatformConfig>({ autoWithdrawal: { enabled: true } }),
    ...overrides,
  });
}

async function seedAutoApprovalConfig() {
  await db.drizzle.db.insert(walletAutoWithdrawalConfig).values({
    singletonKey: 'global',
    fiatThreshold: '1000',
    cryptoThreshold: '0',
    excludeRiskFlags: [],
  });
}

async function seedWallet(balance = '100') {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

async function balanceOf(walletId: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(eq(walletBalance.walletId, walletId));
  return Number(row?.amount ?? 0);
}

async function txById(id: string) {
  return findOneOrThrow(
    await db.drizzle.db.select().from(walletTransaction).where(eq(walletTransaction.id, id)),
    new Error('txById: query returned no row'),
  );
}

async function withdrawalsOf(walletId: string) {
  return db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
}

const hold = (userId: string, source = 'sportsbook', reason = 'unpaid correction') =>
  commands.placeWithdrawalHold(db.drizzle.db, { userId, source, reason });

const withdraw = (svc: WalletService, userId: string) =>
  svc.withdraw({ userId, amount: '40', currency: 'USD', ...NO_CLIENT_META });

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletWithdrawalHold}, ${walletAutoWithdrawalConfig}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WALLET_COMMANDS withdrawal holds (real PG)', () => {
  it('keeps one row per source and updates its reason when placed again', async () => {
    const w = await seedWallet();

    expect(await hold(w.userId, 'sportsbook', 'first')).toEqual({ placed: true });
    expect(await hold(w.userId, 'sportsbook', 'second')).toEqual({ placed: false });

    const rows = await db.drizzle.db.select().from(walletWithdrawalHold);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: w.userId, source: 'sportsbook', reason: 'second' });
  });

  it('refuses a hold for a player with no wallet, writing nothing', async () => {
    await expect(hold(randomUUID())).rejects.toBeInstanceOf(WalletHoldWithoutWalletError);
    expect(await db.drizzle.db.select().from(walletWithdrawalHold)).toEqual([]);
  });

  it('releases only the calling source, and blocks until every source has released', async () => {
    const w = await seedWallet();
    const { svc } = makeService();
    await hold(w.userId, 'sportsbook');
    await hold(w.userId, 'other');

    expect(
      await commands.releaseWithdrawalHold(db.drizzle.db, {
        userId: w.userId,
        source: 'sportsbook',
      }),
    ).toEqual({ released: true });
    await expect(withdraw(svc, w.userId)).rejects.toBeInstanceOf(WithdrawalHeldError);

    expect(
      await commands.releaseWithdrawalHold(db.drizzle.db, {
        userId: w.userId,
        source: 'sportsbook',
      }),
    ).toEqual({ released: false });
    await commands.releaseWithdrawalHold(db.drizzle.db, { userId: w.userId, source: 'other' });

    expect((await withdraw(svc, w.userId)).status).toBe('pending');
  });

  it('commits or rolls back with the caller transaction', async () => {
    const w = await seedWallet();

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await commands.placeWithdrawalHold(tx, {
          userId: w.userId,
          source: 'sportsbook',
          reason: 'debt',
        });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');

    expect(await db.drizzle.db.select().from(walletWithdrawalHold)).toEqual([]);
  });
});

describe('WalletService withdrawals under a module hold (real PG)', () => {
  it('refuses a withdrawal request with a distinct reason, before any debit', async () => {
    const w = await seedWallet();
    const { svc } = makeService();
    await hold(w.userId);

    await expect(withdraw(svc, w.userId)).rejects.toMatchObject({
      name: 'WithdrawalHeldError',
      data: { reason: 'withdrawal_held' },
    });
    expect(await balanceOf(w.id)).toBe(100);
    expect(await withdrawalsOf(w.id)).toEqual([]);
  });

  it('refuses a withdrawal that waited on the wallet lock while the hold was being placed', async () => {
    const w = await seedWallet();
    const { svc } = makeService();
    let commitHold = () => {};
    const holdCommitted = new Promise<void>((resolve) => {
      commitHold = resolve;
    });
    let holdPlaced = () => {};
    const placed = new Promise<void>((resolve) => {
      holdPlaced = resolve;
    });
    const holding = db.drizzle.db.transaction(async (tx) => {
      await commands.placeWithdrawalHold(tx, {
        userId: w.userId,
        source: 'sportsbook',
        reason: 'debt',
      });
      holdPlaced();
      await holdCommitted;
    });
    await placed;

    const withdrawing = withdraw(svc, w.userId);
    await waitForRowLockWaiter(db);
    commitHold();
    await holding;

    await expect(withdrawing).rejects.toBeInstanceOf(WithdrawalHeldError);
    expect(await balanceOf(w.id)).toBe(100);
  });

  it('keeps a queued withdrawal unapprovable until the hold is released', async () => {
    const w = await seedWallet();
    const { svc, psp } = makeService();
    const { transactionId } = await withdraw(svc, w.userId);
    await hold(w.userId);

    await expect(svc.approveWithdrawal(randomUUID(), transactionId)).rejects.toMatchObject({
      name: 'WithdrawalHeldError',
      data: { reason: 'withdrawal_held' },
    });
    expect((await txById(transactionId)).status).toBe('pending');
    expect(psp.processWithdrawal).not.toHaveBeenCalled();

    await commands.releaseWithdrawalHold(db.drizzle.db, { userId: w.userId, source: 'sportsbook' });
    expect((await svc.approveWithdrawal(randomUUID(), transactionId)).status).toBe('completed');
  });

  it('refuses an approval that waited on the wallet lock while the hold was being placed', async () => {
    const w = await seedWallet();
    const { svc, psp } = makeService();
    const { transactionId } = await withdraw(svc, w.userId);
    let commitHold = () => {};
    const holdCommitted = new Promise<void>((resolve) => {
      commitHold = resolve;
    });
    let holdPlaced = () => {};
    const placed = new Promise<void>((resolve) => {
      holdPlaced = resolve;
    });
    const holding = db.drizzle.db.transaction(async (tx) => {
      await commands.placeWithdrawalHold(tx, {
        userId: w.userId,
        source: 'sportsbook',
        reason: 'debt',
      });
      holdPlaced();
      await holdCommitted;
    });
    await placed;

    const approving = svc.approveWithdrawal(randomUUID(), transactionId);
    await waitForRowLockWaiter(db);
    commitHold();
    await holding;

    await expect(approving).rejects.toBeInstanceOf(WithdrawalHeldError);
    expect(await txById(transactionId)).toMatchObject({
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
  });

  it('puts an auto-approval flip back for a human when a hold lands during evaluation', async () => {
    await seedAutoApprovalConfig();
    const w = await seedWallet();
    const { svc, psp } = makeAutoService({
      directory: mock<AdminUserDirectory>({
        lookupPlayers: vi.fn(async (ids: string[]) => {
          await hold(w.userId);
          return ids.map((userId) =>
            mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'approved' }),
          );
        }),
      }),
    });

    const result = await withdraw(svc, w.userId);

    expect(result.status).toBe('pending');
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
    expect(await txById(result.transactionId)).toMatchObject({
      status: 'pending',
      autoApprovalPivotAmount: null,
    });
  });

  it('leaves an auto-approval for a human when it waited on the wallet lock behind a hold', async () => {
    await seedAutoApprovalConfig();
    const w = await seedWallet();
    let holding: Promise<void> = Promise.resolve();
    const { svc, psp } = makeAutoService({
      directory: mock<AdminUserDirectory>({
        lookupPlayers: vi.fn(async (ids: string[]) => {
          let commitHold = () => {};
          const holdCommitted = new Promise<void>((resolve) => {
            commitHold = resolve;
          });
          let holdPlaced = () => {};
          const placed = new Promise<void>((resolve) => {
            holdPlaced = resolve;
          });
          holding = db.drizzle.db.transaction(async (tx) => {
            await commands.placeWithdrawalHold(tx, {
              userId: w.userId,
              source: 'sportsbook',
              reason: 'debt',
            });
            holdPlaced();
            await holdCommitted;
          });
          await placed;
          void waitForRowLockWaiter(db).then(commitHold, commitHold);
          return ids.map((userId) =>
            mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'approved' }),
          );
        }),
      }),
    });

    const result = await withdraw(svc, w.userId);
    await holding;

    expect(result.status).toBe('pending');
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
    expect(await txById(result.transactionId)).toMatchObject({
      status: 'pending',
      autoApprovalPivotAmount: null,
    });
  });

  it("flags a held player's rows in the withdrawal queue", async () => {
    const held = await seedWallet();
    const free = await seedWallet();
    const { svc } = makeService();
    await withdraw(svc, held.userId);
    await withdraw(svc, free.userId);
    await hold(held.userId);

    const { items } = await svc.listWithdrawals({ page: 1, limit: 20 });

    expect(Object.fromEntries(items.map((i) => [i.userId, i.withdrawalHeld]))).toEqual({
      [held.userId]: true,
      [free.userId]: false,
    });
  });
});
