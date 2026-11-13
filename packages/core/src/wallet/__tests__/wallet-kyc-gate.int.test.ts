import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminUserDirectory,
  KycStatus,
  KycWithdrawalPolicy,
  PaymentAdapter,
  PlatformConfig,
  AdminPlayerSummary,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  NO_CLIENT_META,
  makeAuditWriter,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletService, KycRequiredError } from '../service/wallet.service.js';

let db: TestDb;

function makeService(
  kycStatus: KycStatus | null,
  gateWithdrawals: boolean,
  kycPolicy?: KycWithdrawalPolicy,
) {
  const directory = mock<AdminUserDirectory>({
    lookupPlayers: vi.fn(async (ids: string[]) =>
      kycStatus === null
        ? []
        : ids.map((userId) => mock<AdminPlayerSummary>({ userId, username: 'p', kycStatus })),
    ),
  });
  const svc = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({ processWithdrawal: vi.fn() }),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    directory,
    platformConfig: mock<PlatformConfig>({ kyc: { gateWithdrawals } }),
    ...(kycPolicy ? { kycPolicy } : {}),
  });
  return { svc, directory };
}

async function seedWallet() {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: '100' });
  return row;
}

async function txCount(walletId: string) {
  const rows = await db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
  return rows.length;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.withdraw KYC gate (real PG)', () => {
  it('throws KycRequiredError before touching the ledger when the status is not in the pass-set', async () => {
    const { svc } = makeService('pending', true);
    const w = await seedWallet();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(KycRequiredError);
    expect(await txCount(w.id)).toBe(0);
  });

  it('fails closed when the player has no KYC summary at all', async () => {
    const { svc } = makeService(null, true);
    const w = await seedWallet();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(KycRequiredError);
  });

  it('lets a verified player through the gate', async () => {
    const { svc } = makeService('verified', true);
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(await txCount(w.id)).toBe(1);
  });

  it('lets a manually_overridden player through the gate', async () => {
    const { svc } = makeService('manually_overridden', true);
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('never consults the directory when the gate is off', async () => {
    const { svc, directory } = makeService('pending', false);
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(directory.lookupPlayers).not.toHaveBeenCalled();
  });
});

describe('WalletService.withdraw KYC policy (real PG)', () => {
  async function balanceOf(walletId: string) {
    const [row] = await db.drizzle.db
      .select({ amount: walletBalance.amount })
      .from(walletBalance)
      .where(eq(walletBalance.walletId, walletId));
    return row?.amount;
  }

  it('lets an unverified player withdraw when the policy does not require KYC', async () => {
    const requiresKycForWithdrawal = vi.fn(async () => false);
    const { svc, directory } = makeService('pending', true, { requiresKycForWithdrawal });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(requiresKycForWithdrawal).toHaveBeenCalledWith({
      userId: w.userId,
      pivotAmount: '50',
      pivotCurrency: 'USD',
    });
    expect(directory.lookupPlayers).not.toHaveBeenCalled();
  });

  it('refuses an unverified player the policy requires KYC for, without debiting', async () => {
    const { svc } = makeService('pending', true, {
      requiresKycForWithdrawal: vi.fn(async () => true),
    });
    const w = await seedWallet();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(KycRequiredError);
    expect(await txCount(w.id)).toBe(0);
    expect(await balanceOf(w.id)).toBe('100.000000000000000000');
  });

  it('hands the policy a null pivot amount when the currency cannot be priced', async () => {
    const requiresKycForWithdrawal = vi.fn(async () => true);
    const { svc } = makeService('pending', true, { requiresKycForWithdrawal });
    const w = await seedWallet();

    await expect(
      svc.withdraw({ userId: w.userId, amount: '50', currency: 'EUR', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(KycRequiredError);
    expect(requiresKycForWithdrawal).toHaveBeenCalledWith({
      userId: w.userId,
      pivotAmount: null,
      pivotCurrency: 'USD',
    });
  });
});

describe('WalletService.approveWithdrawal KYC re-check (real PG)', () => {
  // The player's KYC status as the directory reports it now; a test revokes it mid-saga.
  let kycStatus: KycStatus;
  function revocableService() {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) => mock<AdminPlayerSummary>({ userId, username: 'p', kycStatus })),
      ),
    });
    const processWithdrawal = vi.fn();
    const svc = new WalletService({
      ...makeWithdrawalPorts(),
      drizzle: db.drizzle,
      events: makeEventBus(),
      payment: mock<PaymentAdapter>({ processWithdrawal }),
      paymentProviders: makePaymentProviderRegistry(),
      audit: makeAuditWriter(),
      identityReader: makeIdentityReader(),
      directory,
      platformConfig: mock<PlatformConfig>({ kyc: { gateWithdrawals: true } }),
    });
    return { svc, directory, processWithdrawal };
  }

  async function statusOf(id: string) {
    const [row] = await db.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id));
    return row?.status;
  }

  beforeEach(() => {
    kycStatus = 'verified';
  });

  it('refuses to approve a withdrawal whose KYC was revoked after the request', async () => {
    const { svc, processWithdrawal } = revocableService();
    const w = await seedWallet();
    const { transactionId } = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });
    kycStatus = 'rejected';

    await expect(svc.approveWithdrawal(randomUUID(), transactionId)).rejects.toBeInstanceOf(
      KycRequiredError,
    );
    expect(await statusOf(transactionId)).toBe('pending');
    expect(processWithdrawal).not.toHaveBeenCalled();
  });

  it('puts the withdrawal back in the queue when KYC is revoked between the check and the payout', async () => {
    const { svc, directory, processWithdrawal } = revocableService();
    const w = await seedWallet();
    const { transactionId } = await svc.withdraw({
      userId: w.userId,
      amount: '50',
      currency: 'USD',
      ...NO_CLIENT_META,
    });
    // Passes the pre-check, revoked by the time the approval flip has committed.
    vi.mocked(directory.lookupPlayers)
      .mockResolvedValueOnce([
        mock<AdminPlayerSummary>({ userId: w.userId, username: 'p', kycStatus: 'verified' }),
      ])
      .mockResolvedValue([
        mock<AdminPlayerSummary>({ userId: w.userId, username: 'p', kycStatus: 'rejected' }),
      ]);

    await expect(svc.approveWithdrawal(randomUUID(), transactionId)).rejects.toBeInstanceOf(
      KycRequiredError,
    );
    expect(await statusOf(transactionId)).toBe('pending');
    expect(processWithdrawal).not.toHaveBeenCalled();
  });
});
