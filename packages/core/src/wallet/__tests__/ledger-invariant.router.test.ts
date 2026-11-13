import { describe, it, expect, vi } from 'vitest';
import { call } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { queue } from '@openora/core/contracts';
import {
  mock,
  makeRealtimeTransport,
  testContext,
  makeAuditWriter,
  makeWithdrawalSecurity,
  makeAdminGuard,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { createWalletRouter } from '../router/index.js';
import type { WalletService } from '../service/wallet.service.js';
import {
  LEDGER_INVARIANT_QUEUE,
  type ReconciliationService,
} from '../service/reconciliation.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000bb';
const FINDING_ID = '9a2f7c11-0000-4000-8000-0000000000cc';
const CALLER_META = { ip: '203.0.113.7', userAgent: 'ledger-test-agent' };

// Holds wallet-reconciliation:run, is not a super admin.
const staffGuard = () =>
  makeAdminGuard({ superAdmin: false, caller: { userId: CALLER_ID, role: 'support' } });

const superAdminGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, ...CALLER_META } });

function routerWith(adminGuard: AdminGuard) {
  const audit = makeAuditWriter();
  const jobQueue = makeJobQueue();
  const resolveFinding = vi.fn(async () => undefined);
  const router = createWalletRouter({
    wallet: mock<WalletService>({}),
    adminGuard,
    audit,
    withdrawalSecurity: makeWithdrawalSecurity(),
    paymentProviders: makePaymentProviderRegistry(),
    reconciliation: mock<ReconciliationService>({ resolveFinding }),
    jobQueue,
    reconciliationQueue: queue('wallet-reconciliation'),
    realtime: makeRealtimeTransport(),
  });
  return { router, audit, jobQueue, resolveFinding };
}

describe('ledger invariant routes', () => {
  it('lets a super admin backfill, auditing the request with where it came from', async () => {
    const { router, audit, jobQueue } = routerWith(superAdminGuard());

    const { runId } = await call(
      router.reconciliation.ledgerInvariant,
      { backfillBaselines: true },
      { context: CTX },
    );

    expect(jobQueue.enqueue).toHaveBeenCalledWith(LEDGER_INVARIANT_QUEUE, {
      runId,
      backfillBaselines: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: CALLER_ID,
        action: 'wallet.ledger_invariant_run.requested',
        resourceId: runId,
        ...CALLER_META,
      }),
    );
  });

  it('refuses a backfill to staff who may run the scan but are not super admins', async () => {
    const { router, audit, jobQueue } = routerWith(staffGuard());

    await expect(
      call(router.reconciliation.ledgerInvariant, { backfillBaselines: true }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets the same staff run a plain scan', async () => {
    const { router, jobQueue } = routerWith(staffGuard());

    const { runId } = await call(router.reconciliation.ledgerInvariant, {}, { context: CTX });

    expect(jobQueue.enqueue).toHaveBeenCalledWith(LEDGER_INVARIANT_QUEUE, {
      runId,
      backfillBaselines: false,
    });
  });

  it('refuses a rebaseline to staff who are not super admins', async () => {
    const { router, resolveFinding } = routerWith(staffGuard());

    await expect(
      call(
        router.reconciliation.resolve,
        { id: FINDING_ID, resolution: { outcome: 'rebaselined', note: 'hand edit confirmed' } },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(resolveFinding).not.toHaveBeenCalled();
  });
});
