import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { paginated } from '@openora/core/contracts/kit';
import {
  JobRunResultSchema,
  WalletReconciliationFindingSchema,
} from '@openora/core/wallet/contract';
import {
  wallet,
  walletBalance,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
} from '@openora/core/wallet/schema';
import { flushAudit, newStaff, registerAndMaterializePlayer } from '../index.js';
import {
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  newDepositScenario,
  newFundedPlayer,
  parseFinding,
  requestWithdrawalId,
  resolveFinding,
  transactionById,
  type WalletE2e,
} from './support/wallet.js';
import { allowDepositing, barFromDepositing } from './support/test-deposit-hold-plugin.js';
import {
  holdSweepListing,
  resetCustodyVendor,
  setSweepableBalances,
  setVendorTransactions,
  sweepsFor,
} from './support/test-custody-plugin.js';

const custodyPlugin = {
  id: 'testing-custody',
  path: fileURLToPath(new URL('./support/test-custody-plugin.ts', import.meta.url)),
};

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([custodyPlugin]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

afterEach(() => resetCustodyVendor());

const db = () => e2e.app.container.get(DRIZZLE).db;
const scenario = () => newDepositScenario(e2e);

const FindingPageSchema = paginated(WalletReconciliationFindingSchema);

async function startRun(path: string, body?: Record<string, unknown>) {
  const res = await e2e.admin.post(path, body);
  expect(res.status).toBe(200);
  return JobRunResultSchema.parse(await res.json()).runId;
}

async function waitForRun(runId: string) {
  return vi.waitFor(
    async () => {
      const [row] = await db().select().from(walletJobRun).where(eq(walletJobRun.runId, runId));
      if (!row?.finishedAt) {
        throw new Error(`run ${runId} has not finished`);
      }
      return row;
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function reconcile() {
  const runId = await startRun('/wallet/reconciliation/run');
  await waitForRun(runId);
  return runId;
}

const findingsOfRun = (runId: string) =>
  db()
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.runId, runId));

async function listFindings(query: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const res = await e2e.admin.get(`/wallet/reconciliation?${params}`);
  expect(res.status).toBe(200);
  return FindingPageSchema.parse(await res.json());
}

async function resolutionAudit(findingId: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'wallet.reconciliation_finding.resolved'),
        eq(auditLog.resourceId, findingId),
      ),
    );
}

async function belowMinimumFinding() {
  const player = await scenario();
  const event = player.deposit({ amount: '5' });
  expect((await deliverWebhook(e2e, event)).status).toBe(200);
  const [finding] = await db()
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.externalId, event.externalId));
  return { player, event, finding: finding! };
}

async function heldDepositFinding() {
  const player = await scenario();
  const event = player.deposit();
  barFromDepositing(player.userId);
  try {
    expect((await deliverWebhook(e2e, event)).status).toBe(200);
  } finally {
    allowDepositing(player.userId);
  }
  const [finding] = await db()
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.externalId, event.externalId));
  return { player, finding: finding! };
}

async function breachedWallet() {
  const player = await scenario();
  expect((await deliverWebhook(e2e, player.deposit({ amount: '20' }))).status).toBe(200);
  await db()
    .update(walletBalance)
    .set({ amount: '99' })
    .where(
      and(
        eq(walletBalance.currency, player.currency),
        inArray(
          walletBalance.walletId,
          db().select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, player.userId)),
        ),
      ),
    );
  const runId = await startRun('/wallet/reconciliation/ledger-invariant', {});
  await waitForRun(runId);
  const [finding] = await db()
    .select()
    .from(walletReconciliationFinding)
    .where(
      and(
        eq(walletReconciliationFinding.kind, 'ledger_invariant_breach'),
        eq(walletReconciliationFinding.currency, player.currency),
      ),
    );
  return { player, runId, finding: finding! };
}

describe('reconciliation and stuck withdrawals', () => {
  it('an admin running reconciliation gets a run id and findings for a deposit the vendor reports and the ledger lacks', async () => {
    const player = await scenario();
    const event = player.deposit({ amount: '25' });
    setVendorTransactions([event]);

    const runId = await reconcile();

    const findings = await findingsOfRun(runId);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'missing_deposit',
        status: 'open',
        externalId: event.externalId,
        currency: player.currency,
        amount: '25.000000000000000000',
        txHash: event.txHash,
      }),
    ]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
  });

  it('an admin listing findings filters by kind and status and pages them', async () => {
    const first = await belowMinimumFinding();
    const second = await belowMinimumFinding();
    const missing = scenario();
    const missingPlayer = await missing;
    setVendorTransactions([missingPlayer.deposit({ amount: '25' })]);
    await reconcile();
    const dismissed = await resolveFinding(e2e.admin, second.finding.id, {
      outcome: 'dismissed',
      note: 'e2e dismissal',
    });
    expect(dismissed.status).toBe(200);

    const openBelow = await listFindings({ kind: 'below_minimum_deposit', status: 'open' });
    const resolvedBelow = await listFindings({ kind: 'below_minimum_deposit', status: 'resolved' });
    const openMissing = await listFindings({ kind: 'missing_deposit', status: 'open' });
    const pageOne = await listFindings({ kind: 'below_minimum_deposit', limit: 1, page: 1 });
    const pageTwo = await listFindings({ kind: 'below_minimum_deposit', limit: 1, page: 2 });

    const ids = (page: z.infer<typeof FindingPageSchema>) => page.items.map((item) => item.id);
    expect(ids(openBelow)).toContain(first.finding.id);
    expect(ids(openBelow)).not.toContain(second.finding.id);
    expect(ids(resolvedBelow)).toContain(second.finding.id);
    expect(ids(resolvedBelow)).not.toContain(first.finding.id);
    expect(openBelow.items.every((item) => item.kind === 'below_minimum_deposit')).toBe(true);
    expect(openMissing.items.every((item) => item.kind === 'missing_deposit')).toBe(true);
    expect(openMissing.items.map((item) => item.currency)).toContain(missingPlayer.currency);
    expect(pageOne.items).toHaveLength(1);
    expect(pageTwo.items).toHaveLength(1);
    expect(pageOne.items[0]!.id).not.toBe(pageTwo.items[0]!.id);
    expect(pageOne.total).toBeGreaterThanOrEqual(2);
  });

  it('an admin resolving a finding as credited, released, refunded, dismissed or rebaselined writes an audit row and applies once', async () => {
    const credit = await belowMinimumFinding();
    const refund = await belowMinimumFinding();
    const held = await heldDepositFinding();
    const dismiss = await belowMinimumFinding();
    const breach = await breachedWallet();
    const refundBody = {
      outcome: 'refunded',
      amount: '5',
      txHash: `refund-${randomUUID()}`,
      destinationAddress: `dest-${randomUUID()}`,
    };
    const cases = [
      { finding: credit.finding, body: { outcome: 'credited' } },
      { finding: held.finding, body: { outcome: 'released' } },
      { finding: refund.finding, body: refundBody },
      { finding: dismiss.finding, body: { outcome: 'dismissed', note: 'e2e dismissal' } },
      { finding: breach.finding, body: { outcome: 'rebaselined', note: 'e2e rebaseline' } },
    ];

    for (const { finding, body } of cases) {
      const first = await resolveFinding(e2e.admin, finding.id, body);
      const again = await resolveFinding(e2e.admin, finding.id, body);
      expect(first.status).toBe(200);
      expect(again.status).toBe(200);
      expect(parseFinding(first.body).status).toBe('resolved');
      const audit = await resolutionAudit(finding.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.after).toEqual(expect.objectContaining({ outcome: body.outcome }));
    }
    expect(await balanceOf(e2e, credit.player.userId, credit.player.currency)).toBe(
      '5.000000000000000000',
    );
    expect(await balanceOf(e2e, held.player.userId, held.player.currency)).toBe(
      '10.000000000000000000',
    );
    expect(await balanceOf(e2e, refund.player.userId, refund.player.currency)).toBe('0');
    expect(await balanceOf(e2e, dismiss.player.userId, dismiss.player.currency)).toBe('0');
  });

  it.todo('resolving an already resolved finding is refused');

  it('a withdrawal stuck without a vendor result is detected and flagged for an admin', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const id = await requestWithdrawalId(player.client, player);
    const approved = await e2e.admin.post(`/wallet/withdrawals/${id}/approve`);
    expect(approved.status).toBe(200);
    const [handed] = await db()
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id));
    expect(handed).toEqual(expect.objectContaining({ status: 'processing' }));
    await db()
      .update(walletTransaction)
      .set({ reviewedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
      .where(eq(walletTransaction.id, id));

    const runId = await reconcile();

    const findings = await findingsOfRun(runId);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'unknown_at_provider',
        status: 'open',
        transactionId: id,
        currency: player.currency,
        amount: '10.000000000000000000',
      }),
    ]);
    expect((await transactionById(e2e, id))?.status).toBe('processing');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('90.000000000000000000');
  });

  it('the ledger invariant check reports a wallet whose balance differs from the sum of its ledger rows', async () => {
    const { player, finding } = await breachedWallet();

    expect(finding).toEqual(
      expect.objectContaining({
        kind: 'ledger_invariant_breach',
        status: 'open',
        currency: player.currency,
        amount: '79.000000000000000000',
      }),
    );
    expect(finding.detail).toContain('over by 79');
  });

  it('a non-admin running or resolving reconciliation is refused with 403', async () => {
    const { finding } = await belowMinimumFinding();
    const player = await registerAndMaterializePlayer(e2e.app, {
      email: `recon-${randomUUID()}@e2e.test`,
    });
    const support = await newStaff(e2e.app, 'recon-support', 'customer-support-agent');

    const attempts = await Promise.all(
      [player.client, support.client].flatMap((client) => [
        client.post('/wallet/reconciliation/run'),
        client.post('/wallet/reconciliation/ledger-invariant', {}),
        resolveFinding(client, finding.id, { outcome: 'dismissed', note: 'nope' }),
      ]),
    );

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403, 403, 403]);
    const [after] = await db()
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.id, finding.id));
    expect(after?.status).toBe('open');
  });
});

describe('custody sweep', () => {
  const SWEEP_AMOUNT = '100';

  async function sweepRows(userId: string) {
    return db().select().from(walletCustodySweep).where(eq(walletCustodySweep.userId, userId));
  }

  async function runSweep() {
    const runId = await startRun('/wallet/custody/sweep/run');
    await waitForRun(runId);
    return runId;
  }

  it('an admin triggering a sweep gets a run id and the sweep moves only funds above the gate', async () => {
    const above = await scenario();
    const dust = await newDepositScenario(e2e);
    setSweepableBalances([
      {
        userId: above.userId,
        currency: above.currency,
        network: 'TESTCHAIN',
        amount: SWEEP_AMOUNT,
        estimatedFee: '1',
      },
      {
        userId: dust.userId,
        currency: dust.currency,
        network: 'TESTCHAIN',
        amount: '5',
        estimatedFee: '1',
      },
    ]);

    const runId = await runSweep();

    const [run] = await db().select().from(walletJobRun).where(eq(walletJobRun.runId, runId));
    expect(run?.status).toBe('completed');
    expect(run?.summary).toEqual(
      expect.objectContaining({ considered: 2, swept: 1, skippedDust: 1 }),
    );
    expect(sweepsFor(above.userId)).toHaveLength(1);
    expect(sweepsFor(dust.userId)).toHaveLength(0);
    expect(await sweepRows(above.userId)).toEqual([
      expect.objectContaining({
        status: 'processing',
        amount: '100.000000000000000000',
        currency: above.currency,
        runId,
      }),
    ]);
    expect(await sweepRows(dust.userId)).toEqual([]);
  });

  it('a sweep does not run while the sweep gate is closed', async () => {
    const player = await scenario();
    const closed = await e2e.admin.put(`/wallet/admin/assets/${player.currency}/TESTCHAIN`, {
      sweepFeeCeiling: '1',
    });
    expect(closed.status).toBe(200);
    setSweepableBalances([
      {
        userId: player.userId,
        currency: player.currency,
        network: 'TESTCHAIN',
        amount: SWEEP_AMOUNT,
        estimatedFee: '2',
      },
    ]);

    const runId = await runSweep();

    const [run] = await db().select().from(walletJobRun).where(eq(walletJobRun.runId, runId));
    expect(run?.summary).toEqual(expect.objectContaining({ swept: 0, skippedCeiling: 1 }));
    expect(sweepsFor(player.userId)).toHaveLength(0);
    expect(await sweepRows(player.userId)).toEqual([]);
  });

  it('a sweep triggered twice at once runs once', async () => {
    const player = await scenario();
    setSweepableBalances([
      {
        userId: player.userId,
        currency: player.currency,
        network: 'TESTCHAIN',
        amount: SWEEP_AMOUNT,
        estimatedFee: '1',
      },
    ]);
    const release = holdSweepListing();

    const [first, second] = await Promise.all([
      startRun('/wallet/custody/sweep/run'),
      startRun('/wallet/custody/sweep/run'),
    ]);
    release();
    await vi.waitFor(
      async () => {
        const rows = await db()
          .select()
          .from(walletJobRun)
          .where(inArray(walletJobRun.runId, [first, second]));
        if (rows.length === 0 || rows.some((row) => !row.finishedAt)) {
          throw new Error('sweep runs still going');
        }
      },
      { timeout: 15_000, interval: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(sweepsFor(player.userId)).toHaveLength(1);
    expect(await sweepRows(player.userId)).toHaveLength(1);
  });

  it('a non-admin triggering a sweep is refused with 403', async () => {
    const player = await registerAndMaterializePlayer(e2e.app, {
      email: `sweep-${randomUUID()}@e2e.test`,
    });
    const support = await newStaff(e2e.app, 'sweep-support', 'customer-support-agent');
    const before = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(walletJobRun);

    const attempts = await Promise.all(
      [player.client, support.client].map((client) => client.post('/wallet/custody/sweep/run')),
    );

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403]);
    const after = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(walletJobRun);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
