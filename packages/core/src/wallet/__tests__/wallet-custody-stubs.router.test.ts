import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { JobQueueAdapter, PaymentAdapter } from '@openora/core/contracts';
import {
  mock,
  makeDrizzle,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000dd';

// The reconciliation routes below only ever run adminGuard.assert() then throw
// NOT_IMPLEMENTED - no DB row is ever read or written, so a mocked DrizzleService is
// enough (no real Postgres). The custody sweep route now enqueues instead of throwing.
function routerWith(guard: AdminGuard, jobQueue?: JobQueueAdapter) {
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
    jobQueue,
  });
}

const authorizedGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, role: 'admin' } });

const deniedGuard = (deny: readonly string[]) =>
  makeAdminGuard({ deny, caller: { userId: CALLER_ID, role: 'support' } });

describe('wallet custody/reconciliation stub routes', () => {
  describe('POST /wallet/custody/sweep/run', () => {
    it('enqueues a sweep cycle and returns its runId for an authorized caller', async () => {
      const enqueue = vi.fn().mockResolvedValue({ id: 'job-1' });
      const jobQueue = mock<JobQueueAdapter>({ enqueue });
      const router = routerWith(authorizedGuard(), jobQueue);

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

    it('501s for an authorized caller - NEVER a success shape, empty or otherwise', async () => {
      const router = routerWith(authorizedGuard());

      await expect(call(router.reconciliation.list, input, { context: CTX })).rejects.toMatchObject(
        { code: 'NOT_IMPLEMENTED' },
      );
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

    it('501s for an authorized caller', async () => {
      const router = routerWith(authorizedGuard());

      await expect(
        call(router.reconciliation.resolve, input, { context: CTX }),
      ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    });

    it('403s for a caller missing wallet-reconciliation:resolve', async () => {
      const router = routerWith(deniedGuard(['wallet-reconciliation:resolve']));

      await expect(
        call(router.reconciliation.resolve, input, { context: CTX }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('POST /wallet/reconciliation/run', () => {
    it('501s for an authorized caller', async () => {
      const router = routerWith(authorizedGuard());

      await expect(call(router.reconciliation.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'NOT_IMPLEMENTED',
      });
    });

    it('403s for a caller missing wallet-reconciliation:run', async () => {
      const router = routerWith(deniedGuard(['wallet-reconciliation:run']));

      await expect(call(router.reconciliation.run, {}, { context: CTX })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
