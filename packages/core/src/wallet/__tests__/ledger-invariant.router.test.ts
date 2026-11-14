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

const DISMISSED = {
  id: FINDING_ID,
  runId: '00000000-0000-0000-0000-000000000000',
  providerName: 'default',
  kind: 'stuck_sweep' as const,
  currency: null,
  network: null,
  amount: null,
  address: null,
  tag: null,
  txHash: null,
  sourceAddress: null,
  externalId: null,
  transactionId: null,
  detail: null,
  status: 'resolved' as const,
  resolvedBy: CALLER_ID,
  resolvedAt: new Date().toISOString(),
  resolutionNote: 'reverted by hand',
  createdAt: new Date().toISOString(),
};

// Holds wallet-reconciliation:run, is not a super admin.
const staffGuard = () =>
  makeAdminGuard({ superAdmin: false, caller: { userId: CALLER_ID, role: 'support' } });

const superAdminGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, ...CALLER_META } });

function routerWith(adminGuard: AdminGuard, { ledgerFinding = true } = {}) {
  const audit = makeAuditWriter();
  const jobQueue = makeJobQueue();
  const resolveFinding = vi.fn(async () => DISMISSED);
  const isLedgerFinding = vi.fn(async () => ledgerFinding);
  const router = createWalletRouter({
    wallet: mock<WalletService>({}),
    adminGuard,
    audit,
    withdrawalSecurity: makeWithdrawalSecurity(),
    paymentProviders: makePaymentProviderRegistry(),
    reconciliation: mock<ReconciliationService>({ resolveFinding, isLedgerFinding }),
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

  it('refuses to staff the dismissal of a ledger finding, but not of a vendor one', async () => {
    const dismiss = {
      id: FINDING_ID,
      resolution: { outcome: 'dismissed', note: 'reverted by hand' },
    } as const;
    const ledger = routerWith(staffGuard());
    const vendor = routerWith(staffGuard(), { ledgerFinding: false });

    await expect(
      call(ledger.router.reconciliation.resolve, dismiss, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await call(vendor.router.reconciliation.resolve, dismiss, { context: CTX });

    expect(ledger.resolveFinding).not.toHaveBeenCalled();
    expect(vendor.resolveFinding).toHaveBeenCalledOnce();
  });
});
