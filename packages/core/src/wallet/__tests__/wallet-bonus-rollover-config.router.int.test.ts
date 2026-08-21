import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { PaymentAdapter, PaymentWebhookVerifier } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction, walletBonusRolloverConfig } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

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

// 'bonus-rollover-config' is granted only to super-admin by default (see
// permissions.ts statement + default-admin-roles.ts: super-admin's matrix is
// computed from every `statement` key, but `admin`/`payments-manager` omit it,
// which defaults to no_access) - both must be denied here.
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
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    audit,
    identityReader: makeIdentityReader(),
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
