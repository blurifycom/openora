import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { queue, type PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction, walletBonusRolloverConfig } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000cc';

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
  await db.drizzle.db.delete(walletBonusRolloverConfig);
});

const superAdminGuard = () =>
  makeAdminGuard({ caller: { userId: CALLER_ID, role: 'super-admin' } });

const adminDenyingGuard = () =>
  makeAdminGuard({
    deny: ['bonus-rollover-config:view', 'bonus-rollover-config:update'],
    caller: { userId: CALLER_ID, role: 'admin' },
  });

const paymentsManagerDenyingGuard = () =>
  makeAdminGuard({
    deny: ['bonus-rollover-config:view', 'bonus-rollover-config:update'],
    caller: { userId: CALLER_ID, role: 'payments-manager' },
  });

function routerWith(adminGuard: AdminGuard) {
  const audit = makeAuditWriter();
  const paymentProviders = makePaymentProviderRegistry();
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
  });
  const router = createWalletRouter({
    wallet: service,
    adminGuard,
    audit,
    paymentProviders,
    reconciliation: mock<ReconciliationService>({}),
    jobQueue: makeJobQueue(),
    reconciliationQueue: RECONCILIATION_QUEUE,
    realtime: new InProcessRealtimeTransport(),
  });
  return { router, audit, service };
}

describe('wallet bonus-rollover-config routes', () => {
  it('get: rejects payments-manager', async () => {
    const { router } = routerWith(paymentsManagerDenyingGuard());

    await expect(
      call(router.bonusRolloverConfig.get, undefined, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('get: rejects plain admin', async () => {
    const { router } = routerWith(adminDenyingGuard());

    await expect(
      call(router.bonusRolloverConfig.get, undefined, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('get: 404s for an authorized (super-admin) caller when unseeded', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(router.bonusRolloverConfig.get, undefined, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('get: returns the seeded singleton row for an authorized (super-admin) caller', async () => {
    await db.drizzle.db
      .insert(walletBonusRolloverConfig)
      .values({ singletonKey: 'global', multiplier: '2' });
    const { router } = routerWith(superAdminGuard());

    const result = await call(router.bonusRolloverConfig.get, undefined, { context: CTX });

    expect(result).toMatchObject({ multiplier: '2.000000000000000000' });
  });

  it('set: rejects payments-manager and writes nothing', async () => {
    const { router, audit } = routerWith(paymentsManagerDenyingGuard());

    await expect(
      call(router.bonusRolloverConfig.set, { multiplier: '3' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('set: rejects plain admin and writes nothing', async () => {
    const { router, audit } = routerWith(adminDenyingGuard());

    await expect(
      call(router.bonusRolloverConfig.set, { multiplier: '3' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('set: rejects a non-positive multiplier', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(router.bonusRolloverConfig.set, { multiplier: '0' }, { context: CTX }),
    ).rejects.toThrow();
  });

  it('set: rejects a multiplier above the operational cap', async () => {
    const { router } = routerWith(superAdminGuard());

    await expect(
      call(
        router.bonusRolloverConfig.set,
        { multiplier: '100.000000000000000001' },
        { context: CTX },
      ),
    ).rejects.toThrow();
  });

  it('set: super-admin updates the multiplier, GET reflects immediately, and writes an admin audit entry with before/after', async () => {
    const { router, audit } = routerWith(superAdminGuard());

    const result = await call(
      router.bonusRolloverConfig.set,
      { multiplier: '3' },
      { context: CTX },
    );

    expect(result).toMatchObject({ multiplier: '3.000000000000000000' });
    const fetched = await call(router.bonusRolloverConfig.get, undefined, { context: CTX });
    expect(fetched).toMatchObject({ multiplier: '3.000000000000000000' });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: CALLER_ID,
        actorType: 'admin',
        action: 'wallet.bonus_rollover_config.set',
        resourceType: 'bonus_rollover_config',
        before: null,
        after: { multiplier: '3.000000000000000000' },
      }),
    );
  });
});
