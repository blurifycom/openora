import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import {
  type AdminPlayerSummary,
  type AdminUserDirectory,
  type PaymentAdapter,
  type PlatformConfig,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
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
  walletAsset,
  walletAutoWithdrawalConfig,
  walletBalance,
  walletTransaction,
} from '../schema/index.js';
import {
  WalletService,
  WalletAssetHasInFlightTransactionsError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  type WalletServiceDeps,
} from '../service/wallet.service.js';

let db: TestDb;

const HOLD_REASON = 'velocity spike under review';
const AUTO_APPROVAL_THRESHOLD = '1000';

function makePsp() {
  return {
    processDeposit: vi.fn(),
    processWithdrawal: vi.fn(async () => ({
      externalId: randomUUID(),
      status: 'completed' as const,
    })),
  };
}

function makeService(overrides: Partial<WalletServiceDeps> = {}) {
  const events = makeEventBus();
  const psp = makePsp();
  const audit = makeAuditWriter();
  const svc = new WalletService({
    drizzle: db.drizzle,
    events,
    payment: mock<PaymentAdapter>(psp),
    paymentProviders: makePaymentProviderRegistry(),
    audit,
    identityReader: makeIdentityReader(),
    ...overrides,
  });
  return { svc, events, psp, audit };
}

async function seedWallet(balance = '0') {
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

async function seedWithdrawal(
  walletId: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'withdrawal',
        amount: '40',
        currency: 'USD',
        status: 'pending',
        rail: 'fiat',
        direction: 'debit',
        ...overrides,
      })
      .returning(),
    new Error('seedWithdrawal: query returned no row'),
  );
}

async function txById(id: string) {
  return findOneOrThrow(
    await db.drizzle.db.select().from(walletTransaction).where(eq(walletTransaction.id, id)),
    new Error('txById: query returned no row'),
  );
}

async function balanceOf(walletId: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(and(eq(walletBalance.walletId, walletId), eq(walletBalance.currency, 'USD')));
  return Number(row?.amount ?? 0);
}

function holdInput(userId: string, withdrawalId: string, adminId = randomUUID()) {
  return { adminId, userId, withdrawalId, reason: HOLD_REASON, proposalId: randomUUID() };
}

const approvedPlayer = (userId: string) =>
  mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'approved' });

async function seedAutoApprovalConfig() {
  await db.drizzle.db.insert(walletAutoWithdrawalConfig).values({
    singletonKey: 'global',
    fiatThreshold: AUTO_APPROVAL_THRESHOLD,
    cryptoThreshold: '0',
    excludeRiskFlags: [],
  });
}

function autoApprovalConfig(
  autoWithdrawal: Partial<NonNullable<PlatformConfig['autoWithdrawal']>> = {},
) {
  return mock<PlatformConfig>({ autoWithdrawal: { enabled: true, ...autoWithdrawal } });
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletAsset}, ${walletAutoWithdrawalConfig}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.holdWithdrawal (real PG)', () => {
  it('moves a pending withdrawal to on_hold and records the reviewer, without moving money', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet('60');
    const pending = await seedWithdrawal(w.id);
    const input = holdInput(w.userId, pending.id);

    const result = await svc.holdWithdrawal(input);

    expect(result).toEqual({ changed: true });
    expect(await txById(pending.id)).toMatchObject({
      status: 'on_hold',
      reviewedBy: input.adminId,
      reviewReason: HOLD_REASON,
    });
    expect((await txById(pending.id)).reviewedAt).toBeInstanceOf(Date);
    expect(await balanceOf(w.id)).toBe(60);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('writes the held audit record before the status change commits', async () => {
    const { svc, audit } = makeService();
    const w = await seedWallet();
    const pending = await seedWithdrawal(w.id);
    const input = holdInput(w.userId, pending.id);
    const statusSeenByAnotherConnection: string[] = [];
    audit.recordInTransaction.mockImplementation(async () => {
      statusSeenByAnotherConnection.push((await txById(pending.id)).status);
    });

    await svc.holdWithdrawal(input);

    expect(statusSeenByAnotherConnection).toEqual(['pending']);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(expect.anything(), {
      actorId: input.adminId,
      actorType: 'admin',
      action: 'wallet.withdrawal.held',
      resourceType: 'withdrawal',
      resourceId: pending.id,
      before: { status: 'pending' },
      after: { status: 'on_hold', reason: HOLD_REASON, proposalId: input.proposalId },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rolls the hold back when its audit record cannot be written', async () => {
    const { svc, audit } = makeService();
    const w = await seedWallet();
    const pending = await seedWithdrawal(w.id);
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit sink down'));

    await expect(svc.holdWithdrawal(holdInput(w.userId, pending.id))).rejects.toThrow(
      'audit sink down',
    );

    expect(await txById(pending.id)).toMatchObject({
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
    });
  });

  it('reports a repeated hold as unchanged, with one status change and one audit record', async () => {
    const { svc, audit } = makeService();
    const w = await seedWallet();
    const pending = await seedWithdrawal(w.id);
    const first = holdInput(w.userId, pending.id);
    await svc.holdWithdrawal(first);
    const heldAt = (await txById(pending.id)).reviewedAt;

    const replay = await svc.holdWithdrawal({ ...first, reason: 'a different reason' });

    expect(replay).toEqual({ changed: false });
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(await txById(pending.id)).toMatchObject({
      status: 'on_hold',
      reviewedBy: first.adminId,
      reviewedAt: heldAt,
      reviewReason: HOLD_REASON,
    });
  });

  it('holds a withdrawal once when two holds race', async () => {
    const { svc, audit } = makeService();
    const w = await seedWallet();
    const pending = await seedWithdrawal(w.id);

    const results = await Promise.all([
      svc.holdWithdrawal(holdInput(w.userId, pending.id)),
      svc.holdWithdrawal(holdInput(w.userId, pending.id)),
    ]);

    expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['processing', 'completed', 'rejected', 'failed'] as const)(
    'refuses to hold a %s withdrawal and leaves it untouched',
    async (status) => {
      const { svc, audit } = makeService();
      const w = await seedWallet();
      const decided = await seedWithdrawal(w.id, { status });

      await expect(svc.holdWithdrawal(holdInput(w.userId, decided.id))).rejects.toBeInstanceOf(
        WithdrawalNotPendingError,
      );

      expect((await txById(decided.id)).status).toBe(status);
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
    },
  );

  it("does not find another player's withdrawal", async () => {
    const { svc } = makeService();
    const owner = await seedWallet();
    const stranger = await seedWallet();
    const pending = await seedWithdrawal(owner.id);

    await expect(svc.holdWithdrawal(holdInput(stranger.userId, pending.id))).rejects.toBeInstanceOf(
      WithdrawalNotFoundError,
    );

    expect((await txById(pending.id)).status).toBe('pending');
  });

  it('does not find a transaction that is not a withdrawal', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    const deposit = await seedWithdrawal(w.id, { type: 'deposit', direction: 'credit' });

    await expect(svc.holdWithdrawal(holdInput(w.userId, deposit.id))).rejects.toBeInstanceOf(
      WithdrawalNotFoundError,
    );
  });

  it('reports the status of a withdrawal to its owner only', async () => {
    const { svc } = makeService();
    const owner = await seedWallet();
    const stranger = await seedWallet();
    const pending = await seedWithdrawal(owner.id);

    expect(
      await svc.getPlayerWithdrawalStatus({ userId: owner.userId, withdrawalId: pending.id }),
    ).toBe('pending');
    expect(
      await svc.getPlayerWithdrawalStatus({ userId: stranger.userId, withdrawalId: pending.id }),
    ).toBeNull();
  });
});

describe('WalletService review of a held withdrawal (real PG)', () => {
  it('approves an on_hold withdrawal and pays it out once', async () => {
    const { svc, psp, events } = makeService();
    const w = await seedWallet('20');
    const pending = await seedWithdrawal(w.id);
    await svc.holdWithdrawal(holdInput(w.userId, pending.id));
    const approver = randomUUID();

    const result = await svc.approveWithdrawal(approver, pending.id, NO_CLIENT_META);

    expect(result).toEqual({ transactionId: pending.id, status: 'completed' });
    expect(psp.processWithdrawal).toHaveBeenCalledTimes(1);
    expect(await txById(pending.id)).toMatchObject({ status: 'completed', reviewedBy: approver });
    expect(await balanceOf(w.id)).toBe(20);
    expect(events.emit.mock.calls.map(([topic]) => topic)).toEqual([
      'wallet.withdrawal.approved',
      'wallet.withdrawal.completed',
    ]);
  });

  it('rejects an on_hold withdrawal and returns the held funds', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet('20');
    const pending = await seedWithdrawal(w.id);
    await svc.holdWithdrawal(holdInput(w.userId, pending.id));
    const reviewer = randomUUID();

    const result = await svc.rejectWithdrawal(reviewer, pending.id, 'source of funds unclear');

    expect(result).toEqual({ transactionId: pending.id, status: 'rejected' });
    expect(await balanceOf(w.id)).toBe(60);
    expect(await txById(pending.id)).toMatchObject({
      status: 'rejected',
      reviewedBy: reviewer,
      reviewReason: 'source of funds unclear',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.rejected',
      expect.objectContaining({ transactionId: pending.id, adminId: reviewer }),
    );
  });

  it('credits a held withdrawal back exactly once when two rejects race', async () => {
    const { svc } = makeService();
    const w = await seedWallet('20');
    const pending = await seedWithdrawal(w.id);
    await svc.holdWithdrawal(holdInput(w.userId, pending.id));

    const results = await Promise.allSettled([
      svc.rejectWithdrawal(randomUUID(), pending.id, 'first'),
      svc.rejectWithdrawal(randomUUID(), pending.id, 'second'),
    ]);

    const refusals = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toBeInstanceOf(WithdrawalNotPendingError);
    expect(await balanceOf(w.id)).toBe(60);
  });

  it('refuses a second review once the held withdrawal is decided', async () => {
    const { svc } = makeService();
    const w = await seedWallet('20');
    const pending = await seedWithdrawal(w.id);
    await svc.holdWithdrawal(holdInput(w.userId, pending.id));
    await svc.rejectWithdrawal(randomUUID(), pending.id, 'rejected');

    await expect(svc.approveWithdrawal(randomUUID(), pending.id)).rejects.toBeInstanceOf(
      WithdrawalNotPendingError,
    );
    expect(await balanceOf(w.id)).toBe(60);
  });
});

describe('WalletService auto-approval against held withdrawals (real PG)', () => {
  function makeAutoService(onKycLookup: () => Promise<void> = async () => undefined) {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) => {
        await onKycLookup();
        return ids.map(approvedPlayer);
      }),
    });
    return makeService({ directory, platformConfig: autoApprovalConfig() });
  }

  it('auto-approves a withdrawal nobody held', async () => {
    await seedAutoApprovalConfig();
    const { svc, psp } = makeAutoService();
    const w = await seedWallet('100');

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
    expect(psp.processWithdrawal).toHaveBeenCalledTimes(1);
  });

  it('never pays out a withdrawal held while its auto-approval was being evaluated', async () => {
    await seedAutoApprovalConfig();
    const w = await seedWallet('100');
    const holder = randomUUID();
    const service: { svc?: WalletService } = {};
    const { svc, psp } = makeAutoService(async () => {
      const [queued] = await db.drizzle.db
        .select({ id: walletTransaction.id })
        .from(walletTransaction)
        .where(eq(walletTransaction.walletId, w.id));
      if (queued && service.svc) {
        await service.svc.holdWithdrawal(holdInput(w.userId, queued.id, holder));
      }
    });
    service.svc = svc;

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(psp.processWithdrawal).not.toHaveBeenCalled();
    expect(await txById(result.transactionId)).toMatchObject({
      status: 'on_hold',
      reviewedBy: holder,
      reviewReason: HOLD_REASON,
      autoApprovalPivotAmount: null,
    });
    expect(await balanceOf(w.id)).toBe(60);
  });

  it("does not count a reviewer's hold that reads 'auto-approved' towards the daily cap", async () => {
    await seedAutoApprovalConfig();
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) => ids.map(approvedPlayer)),
    });
    const { svc } = makeService({
      directory,
      platformConfig: autoApprovalConfig({ dailyCapCount: 1 }),
    });
    const w = await seedWallet('100');
    const held = await seedWithdrawal(w.id, { amount: '10' });
    await svc.holdWithdrawal({ ...holdInput(w.userId, held.id), reason: 'auto-approved' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
  });
});

describe('WalletService.deleteWalletAsset with a held withdrawal (real PG)', () => {
  it('refuses to delete a pair while a withdrawal on it is on hold', async () => {
    const { svc } = makeService();
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'TRC20',
      providerAssetId: 'usdt-trc20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '0',
    });
    const w = await seedWallet();
    await seedWithdrawal(w.id, {
      currency: 'USDT',
      network: 'TRC20',
      rail: 'crypto',
      status: 'on_hold',
    });

    await expect(
      svc.deleteWalletAsset(randomUUID(), 'USDT', 'TRC20', NO_CLIENT_META),
    ).rejects.toBeInstanceOf(WalletAssetHasInFlightTransactionsError);
  });
});
