import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { queue, type JobQueueAdapter, type PaymentAdapter } from '@openora/core/contracts';
import {
  mock,
  makeDrizzle,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000dd';
const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

// Neither route reads or writes a row directly - they authorize, then delegate to a
// service or enqueue a job - so a mocked DrizzleService is enough (no real Postgres).
// The collaborators are per-test doubles so each case can assert what it delegated.
function routerWith(
  guard: AdminGuard,
  overrides: { reconciliation?: ReconciliationService; jobQueue?: JobQueueAdapter } = {},
) {
  const paymentProviders = makePaymentProviderRegistry();
  const service = new WalletService({
    drizzle: makeDrizzle(),
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders,
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
  return createWalletRouter({
    wallet: service,
    adminGuard: guard,
    audit: makeAuditWriter(),
    paymentProviders,
    reconciliation: overrides.reconciliation ?? mock<ReconciliationService>({}),
    jobQueue: overrides.jobQueue ?? makeJobQueue(),
    reconciliationQueue: RECONCILIATION_QUEUE,
  });
}

const authorizedGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, role: 'admin' } });

const deniedGuard = (deny: readonly string[]) =>
  makeAdminGuard({ deny, caller: { userId: CALLER_ID, role: 'support' } });

describe('wallet custody and reconciliation routes', () => {
  describe('POST /wallet/custody/sweep/run', () => {
    it('enqueues a sweep cycle and returns its runId for an authorized caller', async () => {
      const enqueue = vi.fn().mockResolvedValue({ id: 'job-1' });
      const router = routerWith(authorizedGuard(), {
        jobQueue: mock<JobQueueAdapter>({ enqueue }),
      });

      const result = await call(router.custody.sweep.run, {}, { context: CTX });

      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
      const [, payload] = enqueue.mock.calls[0] as [unknown, { runId: string }];
      expect(payload).toEqual({ runId: result.runId });
    });

    it('403s for a caller missing wallet-custody:run', async () => {
      const router = routerWith(deniedGuard(['wallet-custody:run']));

      await expect(call(router.custody.sweep.run, {}, { context: CTX })).rejects.toBeInstanceOf(
        ORPCError,
      );
      await expect(call(router.custody.sweep.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('GET /wallet/reconciliation', () => {
    const input = { page: 1, limit: 20 };

    it('delegates to the reconciliation service for an authorized caller', async () => {
      const listFindings = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 }));
      const router = routerWith(authorizedGuard(), {
        reconciliation: mock<ReconciliationService>({ listFindings }),
      });

      const result = await call(router.reconciliation.list, input, { context: CTX });

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
      expect(listFindings).toHaveBeenCalledWith(input);
    });

    it('403s for a caller missing wallet-reconciliation:view', async () => {
      const router = routerWith(deniedGuard(['wallet-reconciliation:view']));

      await expect(call(router.reconciliation.list, input, { context: CTX })).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      );
    });
  });

  describe('POST /wallet/reconciliation/{id}/resolve', () => {
    const input = {
      id: '63d3c264-3bf4-4d08-9b92-ea3eaf40a440',
      resolution: { outcome: 'dismissed' as const, note: 'confirmed non-issue' },
    };
    const resolved = {
      id: input.id,
      runId: '00000000-0000-0000-0000-000000000000',
      providerName: 'default',
      kind: 'missing_deposit' as const,
      currency: 'BTC',
      network: null,
      amount: '1',
      address: null,
      tag: null,
      txHash: null,
      externalId: 'vendor-ext-1',
      transactionId: null,
      detail: null,
      status: 'resolved' as const,
      resolvedBy: CALLER_ID,
      resolvedAt: new Date().toISOString(),
      resolutionNote: input.resolution.note,
      createdAt: new Date().toISOString(),
    };

    it('delegates to the reconciliation service for an authorized caller', async () => {
      const resolveFinding = vi.fn(async () => resolved);
      const router = routerWith(authorizedGuard(), {
        reconciliation: mock<ReconciliationService>({ resolveFinding }),
      });

      const result = await call(router.reconciliation.resolve, input, { context: CTX });

      expect(result).toEqual(resolved);
      expect(resolveFinding).toHaveBeenCalledWith(
        CALLER_ID,
        input.id,
        input.resolution,
        expect.objectContaining({}),
      );
    });

    it('403s for a caller missing wallet-reconciliation:resolve', async () => {
      const router = routerWith(deniedGuard(['wallet-reconciliation:resolve']));

      await expect(
        call(router.reconciliation.resolve, input, { context: CTX }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('POST /wallet/reconciliation/run', () => {
    it('enqueues the job and returns a runId for an authorized caller, never running inline', async () => {
      const jobQueue = makeJobQueue();
      const router = routerWith(authorizedGuard(), { jobQueue });

      const result = await call(router.reconciliation.run, {}, { context: CTX });

      expect(result.runId).toEqual(expect.any(String));
      expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(jobQueue.enqueue).toHaveBeenCalledWith(RECONCILIATION_QUEUE, { runId: result.runId });
    });

    it('403s for a caller missing wallet-reconciliation:run', async () => {
      const router = routerWith(deniedGuard(['wallet-reconciliation:run']));

      await expect(call(router.reconciliation.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
