import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PlatformConfig } from '@openora/core/contracts';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../../migrate.js';
import {
  wallet,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
  type WalletJobRun,
  type WalletTransaction,
} from '../../schema/index.js';
import { ReconciliationService } from '../reconciliation.service.js';
import { WalletService } from '../wallet.service.js';

const RECONCILIATION_CONFIG: NonNullable<PlatformConfig['wallet']>['reconciliation'] = {
  cron: '0 * * * *',
  lookbackHours: 24,
  batchSize: 200,
  stuckAfterMinutes: 60,
  staleRunAfterMinutes: 30,
  alertThreshold: 10,
  outboxLagAlertMinutes: 5,
  deadLetterAlertThreshold: 0,
};

const TWO_DAYS_AGO = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb([migrateServer, migrate]);
});

afterEach(async () => {
  await db.drop();
});

function makeServices() {
  const audit = makeAuditWriter();
  const paymentProviders = makePaymentProviderRegistry();
  const platformConfig = mock<PlatformConfig>({
    wallet: { reconciliation: RECONCILIATION_CONFIG },
  });
  const walletService = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock(),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
    platformConfig,
  });
  const reconciliation = new ReconciliationService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    wallet: walletService,
    paymentProviders,
    audit,
    platformConfig,
  });
  return { reconciliation, audit };
}

async function seedStuckRequestedWithdrawal() {
  const [walletRow] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), currency: 'USD' })
    .returning();
  if (!walletRow) {
    throw new Error('seedStuckRequestedWithdrawal: no wallet row');
  }
  const [tx] = await db.drizzle.db
    .insert(walletTransaction)
    .values({
      walletId: walletRow.id,
      type: 'withdrawal',
      amount: '25',
      currency: 'USD',
      status: 'pending',
      createdAt: TWO_DAYS_AGO(),
    })
    .returning();
  if (!tx) {
    throw new Error('seedStuckRequestedWithdrawal: no transaction row');
  }
  return tx;
}

async function approveWithoutDispatch(transactionId: WalletTransaction['id']) {
  await db.drizzle.db
    .update(walletTransaction)
    .set({ status: 'processing', reviewedAt: TWO_DAYS_AGO() })
    .where(eq(walletTransaction.id, transactionId));
}

async function requestedFinding(transactionId: WalletTransaction['id']) {
  const [row] = await db.drizzle.db
    .select()
    .from(walletReconciliationFinding)
    .where(
      and(
        eq(walletReconciliationFinding.kind, 'stuck_withdrawal_requested'),
        eq(walletReconciliationFinding.transactionId, transactionId),
      ),
    );
  if (!row) {
    throw new Error('requestedFinding: no stuck_withdrawal_requested finding');
  }
  return row;
}

async function stuckWithdrawalsFiled(runId: WalletJobRun['runId']) {
  const [run] = await db.drizzle.db
    .select({ summary: walletJobRun.summary })
    .from(walletJobRun)
    .where(eq(walletJobRun.runId, runId));
  return (run?.summary as { stuckWithdrawals?: number } | null)?.stuckWithdrawals;
}

async function runCycle(reconciliation: ReconciliationService) {
  const run = await reconciliation.runCycle();
  if (!run) {
    throw new Error('runCycle: the cycle did not claim its run');
  }
  return run.runId;
}

describe('a withdrawal that gets stuck again after the cycle closed its finding', () => {
  it('reopens the system-closed finding, counts it as filed and audits the reopen', async () => {
    const { reconciliation, audit } = makeServices();
    const tx = await seedStuckRequestedWithdrawal();

    const firstRun = await runCycle(reconciliation);
    expect(await stuckWithdrawalsFiled(firstRun)).toBe(1);
    const filed = await requestedFinding(tx.id);

    await approveWithoutDispatch(tx.id);
    const secondRun = await runCycle(reconciliation);

    const [requeued] = await db.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, tx.id));
    expect(requeued?.status).toBe('pending');
    const reopened = await requestedFinding(tx.id);
    expect(reopened).toMatchObject({
      id: filed.id,
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      runId: secondRun,
    });
    expect(await stuckWithdrawalsFiled(secondRun)).toBe(2);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.reconciliation_finding.reopened',
        resourceId: filed.id,
        before: { status: 'resolved' },
      }),
    );
  });

  it('leaves a finding an admin closed resolved', async () => {
    const { reconciliation, audit } = makeServices();
    const tx = await seedStuckRequestedWithdrawal();
    await runCycle(reconciliation);
    const filed = await requestedFinding(tx.id);
    const adminId = randomUUID();
    await db.drizzle.db
      .update(walletReconciliationFinding)
      .set({
        status: 'resolved',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        resolutionNote: 'checked with the player',
      })
      .where(eq(walletReconciliationFinding.id, filed.id));

    await approveWithoutDispatch(tx.id);
    const secondRun = await runCycle(reconciliation);

    expect(await requestedFinding(tx.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: adminId,
      resolutionNote: 'checked with the player',
    });
    expect(await stuckWithdrawalsFiled(secondRun)).toBe(1);
    expect(audit.recordInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.reconciliation_finding.reopened' }),
    );
  });
});
