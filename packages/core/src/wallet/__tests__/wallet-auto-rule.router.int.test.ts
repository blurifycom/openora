import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { queue, type PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeRealtimeTransport,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { autoWithdrawalRule } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

const CTX = testContext();
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000aa';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(autoWithdrawalRule);
});

const allowingGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID } });

const autoRuleDenyingGuard = () =>
  makeAdminGuard({
    deny: ['withdrawal:auto-rule'],
    caller: { userId: CALLER_ID, role: 'support' },
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
    realtime: makeRealtimeTransport(),
  });
  return { router, audit };
}

async function storedRule(userId: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(autoWithdrawalRule)
    .where(eq(autoWithdrawalRule.userId, userId));
  return row;
}

async function seedRule() {
  await db.drizzle.db
    .insert(autoWithdrawalRule)
    .values({ userId: USER_ID, threshold: '500', reason: 'trusted', createdBy: CALLER_ID });
}

describe('wallet auto-withdrawal-rule routes', () => {
  it('set: persists the rule and writes an admin audit entry', async () => {
    const { router, audit } = routerWith(allowingGuard());

    const result = await call(
      router.autoWithdrawalRules.set,
      { userId: USER_ID, threshold: '500', reason: 'trusted' },
      { context: CTX },
    );

    expect(result.threshold).toBe('500.000000000000000000');
    expect(result.createdBy).toBe(CALLER_ID);
    expect((await storedRule(USER_ID))?.reason).toBe('trusted');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        action: 'wallet.auto_withdrawal_rule.set',
        resourceType: 'auto_withdrawal_rule',
        resourceId: USER_ID,
        after: { threshold: '500.000000000000000000', reason: 'trusted' },
      }),
    );
  });

  it('set: overwrites the existing rule rather than adding a second one', async () => {
    await seedRule();
    const { router } = routerWith(allowingGuard());

    await call(
      router.autoWithdrawalRules.set,
      { userId: USER_ID, threshold: '900', reason: 'raised' },
      { context: CTX },
    );

    const rows = await db.drizzle.db
      .select()
      .from(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('raised');
  });

  it('set: rejects a caller lacking withdrawal:auto-rule and writes nothing', async () => {
    const { router, audit } = routerWith(autoRuleDenyingGuard());

    await expect(
      call(
        router.autoWithdrawalRules.set,
        { userId: USER_ID, threshold: '500', reason: 'trusted' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await storedRule(USER_ID)).toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('delete: removes the rule and writes an admin audit entry', async () => {
    await seedRule();
    const { router, audit } = routerWith(allowingGuard());

    const result = await call(
      router.autoWithdrawalRules.delete,
      { userId: USER_ID },
      { context: CTX },
    );

    expect(result).toBe(true);
    expect(await storedRule(USER_ID)).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.auto_withdrawal_rule.deleted',
        resourceId: USER_ID,
      }),
    );
  });

  it('delete: reports false when there was no rule to remove', async () => {
    const { router } = routerWith(allowingGuard());

    expect(
      await call(router.autoWithdrawalRules.delete, { userId: USER_ID }, { context: CTX }),
    ).toBe(false);
  });

  it('delete: rejects a caller lacking withdrawal:auto-rule and leaves the rule in place', async () => {
    await seedRule();
    const { router } = routerWith(autoRuleDenyingGuard());

    await expect(
      call(router.autoWithdrawalRules.delete, { userId: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await storedRule(USER_ID)).toBeDefined();
  });

  it('get: returns the stored rule for an authorized caller', async () => {
    await seedRule();
    const { router } = routerWith(allowingGuard());

    const result = await call(
      router.autoWithdrawalRules.get,
      { userId: USER_ID },
      { context: CTX },
    );

    expect(result).toMatchObject({
      userId: USER_ID,
      threshold: '500.000000000000000000',
      reason: 'trusted',
    });
  });

  it('get: returns null when the player has no rule', async () => {
    const { router } = routerWith(allowingGuard());

    expect(await call(router.autoWithdrawalRules.get, { userId: USER_ID }, { context: CTX })).toBe(
      null,
    );
  });

  it('get: rejects a caller lacking withdrawal:auto-rule', async () => {
    const { router } = routerWith(autoRuleDenyingGuard());

    await expect(
      call(router.autoWithdrawalRules.get, { userId: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
