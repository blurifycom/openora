import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { findOneOrThrow } from '@openora/core/server';
import { queue, type PaymentAdapter, type PlatformConfig } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeWithdrawalSecurity,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import { ReconciliationService } from '../service/reconciliation.service.js';
import {
  wallet,
  walletTransaction,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
  walletDepositAddress,
} from '../schema/index.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000dd';
const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateServer, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletCustodySweep}, ${walletJobRun}, ${walletReconciliationFinding}, ${walletDepositAddress}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

function routerWith(guard: AdminGuard, jobQueue = makeJobQueue()) {
  const paymentProviders = makePaymentProviderRegistry();
  const audit = makeAuditWriter();
  const platformConfig = mock<PlatformConfig>({});
  const service = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders,
    audit,
    withdrawalSecurity: makeWithdrawalSecurity(),
    identityReader: makeIdentityReader(),
    platformConfig,
  });
  const reconciliation = new ReconciliationService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    wallet: service,
    paymentProviders,
    audit,
    platformConfig,
  });
  const router = createWalletRouter({
    wallet: service,
    adminGuard: guard,
    audit,
    withdrawalSecurity: makeWithdrawalSecurity(),
    paymentProviders,
    reconciliation,
    jobQueue,
    reconciliationQueue: RECONCILIATION_QUEUE,
    realtime: mock({}),
  });
  return { router, jobQueue };
}

async function seedFinding(kind: 'missing_deposit' | 'ledger_unrequested_transaction') {
  const runId = randomUUID();
  await db.drizzle.db
    .insert(walletJobRun)
    .values({ jobName: 'wallet-reconciliation', runId, finishedAt: new Date() });
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletReconciliationFinding)
      .values({
        runId,
        providerName: 'default',
        kind,
        currency: 'BTC',
        amount: '1',
        externalId: randomUUID(),
      })
      .returning(),
    new Error('seedFinding: insert returned no row'),
  );
}

async function statusOf(id: string) {
  const [row] = await db.drizzle.db
    .select({ status: walletReconciliationFinding.status })
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.id, id));
  return row?.status;
}

const authorizedGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, role: 'admin' } });

const deniedGuard = (deny: readonly string[]) =>
  makeAdminGuard({ deny, caller: { userId: CALLER_ID, role: 'support' } });

const plainAdminGuard = () =>
  makeAdminGuard({ caller: { userId: CALLER_ID, role: 'admin' }, superAdmin: false });

describe('wallet custody and reconciliation routes (real PG)', () => {
  describe('POST /wallet/custody/sweep/run', () => {
    it('enqueues a sweep cycle and returns its runId for an authorized caller', async () => {
      const { router, jobQueue } = routerWith(authorizedGuard());

      const result = await call(router.custody.sweep.run, {}, { context: CTX });

      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(jobQueue.enqueue).toHaveBeenCalledWith(expect.anything(), { runId: result.runId });
    });

    it('403s for a caller missing wallet-custody:run, enqueuing nothing', async () => {
      const { router, jobQueue } = routerWith(deniedGuard(['wallet-custody:run']));

      await expect(call(router.custody.sweep.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('GET /wallet/reconciliation', () => {
    it('lists the stored findings for an authorized caller', async () => {
      const finding = await seedFinding('missing_deposit');
      const { router } = routerWith(authorizedGuard());

      const result = await call(
        router.reconciliation.list,
        { page: 1, limit: 20 },
        { context: CTX },
      );

      expect(result.total).toBe(1);
      expect(result.items).toEqual([expect.objectContaining({ id: finding.id, status: 'open' })]);
    });

    it('403s for a caller missing wallet-reconciliation:view', async () => {
      const { router } = routerWith(deniedGuard(['wallet-reconciliation:view']));

      await expect(
        call(router.reconciliation.list, { page: 1, limit: 20 }, { context: CTX }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('POST /wallet/reconciliation/{id}/resolve', () => {
    const dismissed = { outcome: 'dismissed' as const, note: 'confirmed non-issue' };

    it('lets a plain admin dismiss a deposit finding and records who resolved it', async () => {
      const finding = await seedFinding('missing_deposit');
      const { router } = routerWith(plainAdminGuard());

      const result = await call(
        router.reconciliation.resolve,
        { id: finding.id, resolution: dismissed },
        { context: CTX },
      );

      expect(result).toMatchObject({ id: finding.id, status: 'resolved', resolvedBy: CALLER_ID });
      expect(await statusOf(finding.id)).toBe('resolved');
    });

    it('403s a plain admin resolving with an outcome that credits a balance, moving nothing', async () => {
      const finding = await seedFinding('missing_deposit');
      const { router } = routerWith(plainAdminGuard());

      for (const resolution of [
        { outcome: 'credited' as const },
        { outcome: 'credited' as const, userId: CALLER_ID },
        { outcome: 'released' as const },
      ]) {
        await expect(
          call(router.reconciliation.resolve, { id: finding.id, resolution }, { context: CTX }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await statusOf(finding.id)).toBe('open');
      expect(await db.drizzle.db.select().from(walletTransaction)).toEqual([]);
    });

    it('403s a plain admin dismissing a ledger finding, leaving it open', async () => {
      const finding = await seedFinding('ledger_unrequested_transaction');
      const { router } = routerWith(plainAdminGuard());

      await expect(
        call(
          router.reconciliation.resolve,
          { id: finding.id, resolution: dismissed },
          { context: CTX },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await statusOf(finding.id)).toBe('open');
    });

    it('403s for a caller missing wallet-reconciliation:resolve, leaving the finding open', async () => {
      const finding = await seedFinding('missing_deposit');
      const { router } = routerWith(deniedGuard(['wallet-reconciliation:resolve']));

      await expect(
        call(
          router.reconciliation.resolve,
          { id: finding.id, resolution: dismissed },
          { context: CTX },
        ),
      ).rejects.toBeInstanceOf(ORPCError);
      expect(await statusOf(finding.id)).toBe('open');
    });
  });

  describe('POST /wallet/reconciliation/run', () => {
    it('enqueues the job and returns a runId for an authorized caller, never running inline', async () => {
      const { router, jobQueue } = routerWith(authorizedGuard());

      const result = await call(router.reconciliation.run, {}, { context: CTX });

      expect(result.runId).toEqual(expect.any(String));
      expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(jobQueue.enqueue).toHaveBeenCalledWith(RECONCILIATION_QUEUE, { runId: result.runId });
      expect(await db.drizzle.db.select().from(walletJobRun)).toEqual([]);
    });

    it('403s for a caller missing wallet-reconciliation:run', async () => {
      const { router, jobQueue } = routerWith(deniedGuard(['wallet-reconciliation:run']));

      await expect(call(router.reconciliation.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });
  });
});
