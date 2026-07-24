import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import type {
  AdminUserDirectory,
  AuditWritePort,
  KycStatus,
  PaymentAdapter,
  PlatformConfig,
  AdminPlayerSummary,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEvents, NO_CLIENT_META } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { WalletService, KycRequiredError } from '../service/wallet.service.js';

let db: TestDb;

function makeService(kycStatus: KycStatus | null, gateWithdrawals: boolean) {
  const directory = mock<AdminUserDirectory>({
    lookupPlayers: vi.fn(async (ids: string[]) =>
      kycStatus === null
        ? []
        : ids.map((userId) => mock<AdminPlayerSummary>({ userId, username: 'p', kycStatus })),
    ),
  });
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: mock<EventBus>(makeEvents()),
    payment: mock<PaymentAdapter>({ processWithdrawal: vi.fn() }),
    audit: mock<AuditWritePort>({ record: vi.fn() }),
    directory,
    platformConfig: mock<PlatformConfig>({ kyc: { gateWithdrawals } }),
  });
  return { svc, directory };
}

async function seedWallet() {
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), balance: '100', currency: 'USD' })
    .returning();
  return row!;
}

async function txCount(walletId: string) {
  const rows = await db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
  return rows.length;
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
