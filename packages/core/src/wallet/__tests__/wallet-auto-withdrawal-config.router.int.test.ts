import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  AdminPlayerSummary,
  AdminUserDirectory,
  PaymentAdapter,
  PaymentWebhookVerifier,
  PlatformConfig,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction, walletAutoWithdrawalConfig } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000bb';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletTransaction);
  await db.drizzle.db.delete(wallet);
  await db.drizzle.db.delete(walletAutoWithdrawalConfig);
  await db.drizzle.db
    .insert(walletAutoWithdrawalConfig)
    .values({ singletonKey: 'global', fiatThreshold: '0', cryptoThreshold: '0' });
});

const superAdminGuard = () =>
  makeAdminGuard({ caller: { userId: CALLER_ID, role: 'super-admin' } });

// The 'auto-withdrawal-config' resource is granted only to super-admin (see
// permissions.ts statement + default-admin-roles.ts) - both `admin` and
// `payments-manager` (which only has `withdrawal` RW, a different resource)
// must be denied here.
const adminDenyingGuard = () =>
  makeAdminGuard({
    deny: ['auto-withdrawal-config:view', 'auto-withdrawal-config:update'],
    caller: { userId: CALLER_ID, role: 'admin' },
  });

const paymentsManagerDenyingGuard = () =>
  makeAdminGuard({
    deny: ['auto-withdrawal-config:view', 'auto-withdrawal-config:update'],
    caller: { userId: CALLER_ID, role: 'payments-manager' },
  });

function routerWith(adminGuard: AdminGuard, platformConfig?: Partial<PlatformConfig>) {
  const audit = makeAuditWriter();
  const directory = mock<AdminUserDirectory>({
    lookupPlayers: vi.fn(async (ids: string[]) =>
      ids.map((userId) =>
        mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'verified' }),
      ),
    ),
  });
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({
      processWithdrawal: vi.fn(async () => ({
        externalId: randomUUID(),
        status: 'completed' as const,
      })),
    }),
    audit,
    directory,
    platformConfig: platformConfig ? mock<PlatformConfig>(platformConfig) : undefined,
  });
  const router = createWalletRouter(
    service,
    adminGuard,
    audit,
    mock<PaymentAdapter>({}),
    mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) }),
  );
  return { router, audit, service };
}

async function seedPlayerWallet(overrides: Partial<typeof wallet.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), balance: '100000', currency: 'USD', ...overrides })
    .returning();
  return row!;
}

describe('wallet auto-withdrawal-config routes', () => {
  it('get: returns the seeded singleton row for an authorized (super-admin) caller', async () => {
    const { router } = routerWith(superAdminGuard());

    const result = await call(router.autoWithdrawalConfig.get, {}, { context: CTX });

    expect(result).toMatchObject({ fiatThreshold: '0.00000000', cryptoThreshold: '0.00000000' });
  });

  it('get: rejects payments-manager', async () => {
    const { router } = routerWith(paymentsManagerDenyingGuard());

    await expect(
      call(router.autoWithdrawalConfig.get, {}, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('get: rejects plain admin', async () => {
    const { router } = routerWith(adminDenyingGuard());

    await expect(
      call(router.autoWithdrawalConfig.get, {}, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('set: rejects payments-manager and writes nothing', async () => {
    const { router, audit } = routerWith(paymentsManagerDenyingGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '500', cryptoThreshold: '1' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('set: rejects plain admin and writes nothing', async () => {
    const { router, audit } = routerWith(adminDenyingGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '500', cryptoThreshold: '1' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('set: rejects a negative fiat threshold', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '-1', cryptoThreshold: '1' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: rejects a negative crypto threshold', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '1', cryptoThreshold: '-1' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: rejects a fiat threshold exceeding the decimal(18,8) integer-digit budget', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '10000000000', cryptoThreshold: '1' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: super-admin updates both thresholds, GET reflects immediately, and writes an admin audit entry with before/after', async () => {
    const { router, audit } = routerWith(superAdminGuard());

    const result = await call(
      router.autoWithdrawalConfig.set,
      { fiatThreshold: '500', cryptoThreshold: '1' },
      { context: CTX },
    );

    expect(result).toMatchObject({
      fiatThreshold: '500.00000000',
      cryptoThreshold: '1.00000000',
      updatedBy: CALLER_ID,
    });
    const fetched = await call(router.autoWithdrawalConfig.get, {}, { context: CTX });
    expect(fetched).toMatchObject({
      fiatThreshold: '500.00000000',
      cryptoThreshold: '1.00000000',
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: CALLER_ID,
        actorType: 'admin',
        action: 'wallet.auto_withdrawal_config.set',
        resourceType: 'auto_withdrawal_config',
        before: { fiatThreshold: '0.00000000', cryptoThreshold: '0.00000000' },
        after: { fiatThreshold: '500.00000000', cryptoThreshold: '1.00000000' },
      }),
    );
  });

  it('end-to-end: after a super-admin sets the fiat threshold, a withdrawal below it auto-approves and one above it stays pending, both leaving an audit trail', async () => {
    const { router, audit, service } = routerWith(superAdminGuard(), {
      autoWithdrawal: { enabled: true, excludeRiskFlags: [] },
    });

    await call(
      router.autoWithdrawalConfig.set,
      { fiatThreshold: '100', cryptoThreshold: '0' },
      { context: CTX },
    );

    const below = await seedPlayerWallet();
    const belowResult = await service.withdraw({
      userId: below.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });
    expect(belowResult.status).toBe('completed');

    const above = await seedPlayerWallet();
    const aboveResult = await service.withdraw({
      userId: above.userId,
      amount: '400',
      currency: 'USD',
      ...NO_CLIENT_META,
    });
    expect(aboveResult.status).toBe('pending');

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.auto_withdrawal_config.set' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.withdrawal.auto_approved',
        resourceId: belowResult.transactionId,
      }),
    );
  });
});
