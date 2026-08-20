import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  AdminPlayerSummary,
  AdminUserDirectory,
  PaymentAdapter,
  PlatformConfig,
  PlayerTags,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makePaymentProviderRegistry,
  NO_CLIENT_META,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletAutoWithdrawalConfig,
} from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000bb';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
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
  // excludeRiskFlags defaults to the migration's 5-tag DEFAULT (non-empty), so
  // evaluateAutoApproval needs PLAYER_TAGS bound to check it - bind an empty-tags double by
  // default so tests that aren't specifically exercising risk-tag exclusion still reach
  // auto-approval.
  const riskTags = mock<PlayerTags>({
    getActiveTagKeys: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, []]))),
  });
  const paymentProviders = makePaymentProviderRegistry();
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({
      processWithdrawal: vi.fn(async () => ({
        externalId: randomUUID(),
        status: 'completed' as const,
      })),
    }),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
    directory,
    platformConfig: platformConfig ? mock<PlatformConfig>(platformConfig) : undefined,
    riskTags,
  });
  const router = createWalletRouter(service, adminGuard, audit, paymentProviders);
  return { router, audit, service };
}

async function seedPlayerWallet({
  balance = '100000',
  ...overrides
}: Partial<typeof wallet.$inferInsert> & { balance?: string } = {}) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD', ...overrides })
      .returning(),
    new Error('seedPlayerWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

describe('wallet auto-withdrawal-config routes', () => {
  it('get: returns the seeded singleton row for an authorized (super-admin) caller', async () => {
    const { router } = routerWith(superAdminGuard());

    const result = await call(router.autoWithdrawalConfig.get, {}, { context: CTX });

    expect(result).toMatchObject({
      fiatThreshold: '0.000000000000000000',
      cryptoThreshold: '0.000000000000000000',
    });
    expect(result.excludeRiskFlags).toEqual(
      expect.arrayContaining(['high_risk', 'bonus_abuser', 'kyc_rejected']),
    );
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
        { fiatThreshold: '500', cryptoThreshold: '1', excludeRiskFlags: [] },
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
        { fiatThreshold: '500', cryptoThreshold: '1', excludeRiskFlags: [] },
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
        { fiatThreshold: '-1', cryptoThreshold: '1', excludeRiskFlags: [] },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: rejects a negative crypto threshold', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '1', cryptoThreshold: '-1', excludeRiskFlags: [] },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: rejects a fiat threshold exceeding the decimal(18,8) integer-digit budget', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.autoWithdrawalConfig.set,
        { fiatThreshold: '10000000000', cryptoThreshold: '1', excludeRiskFlags: [] },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: super-admin updates both thresholds and excludeRiskFlags, GET reflects immediately, and writes an admin audit entry with before/after', async () => {
    const { router, audit } = routerWith(superAdminGuard());

    const result = await call(
      router.autoWithdrawalConfig.set,
      { fiatThreshold: '500', cryptoThreshold: '1', excludeRiskFlags: ['bonus_abuser'] },
      { context: CTX },
    );

    expect(result).toMatchObject({
      fiatThreshold: '500.000000000000000000',
      cryptoThreshold: '1.000000000000000000',
      excludeRiskFlags: ['bonus_abuser'],
      updatedBy: CALLER_ID,
    });
    const fetched = await call(router.autoWithdrawalConfig.get, {}, { context: CTX });
    expect(fetched).toMatchObject({
      fiatThreshold: '500.000000000000000000',
      cryptoThreshold: '1.000000000000000000',
      excludeRiskFlags: ['bonus_abuser'],
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: CALLER_ID,
        actorType: 'admin',
        action: 'wallet.auto_withdrawal_config.set',
        resourceType: 'auto_withdrawal_config',
        before: {
          fiatThreshold: '0.000000000000000000',
          cryptoThreshold: '0.000000000000000000',
          // The beforeEach seed omits excludeRiskFlags, so the column's migration
          // DEFAULT (a starting value, not an enforced floor) is what "before" captures here.
          excludeRiskFlags: [
            'high_risk',
            'bonus_abuser',
            'kyc_rejected',
            'withdrawal_review',
            'multi_account',
          ],
        },
        after: {
          fiatThreshold: '500.000000000000000000',
          cryptoThreshold: '1.000000000000000000',
          excludeRiskFlags: ['bonus_abuser'],
        },
      }),
    );
  });

  it('end-to-end: after a super-admin sets the fiat threshold, a withdrawal below it auto-approves and one above it stays pending, both leaving an audit trail', async () => {
    const { router, audit, service } = routerWith(superAdminGuard(), {
      autoWithdrawal: { enabled: true },
    });

    await call(
      router.autoWithdrawalConfig.set,
      { fiatThreshold: '100', cryptoThreshold: '0', excludeRiskFlags: [] },
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
