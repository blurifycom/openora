import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { AuditWritePort, WalletReconciliationFindingKind } from '@openora/core/contracts';
import { walletReconciliationFinding } from '../schema/index.js';

/**
 * Sentinel `runId` for a finding produced OUTSIDE any reconciliation job cycle - the
 * live webhook path (`WalletService.creditDepositByAddress`) hits an unattributable
 * deposit in real time, not on a poll. `runId` is NOT NULL on the table, so this fixed
 * zero-uuid documents "no job run owns this row", mirroring the audit plugin's
 * SYSTEM_ACTOR sentinel for "no admin acted here".
 */
export const LIVE_WEBHOOK_RUN_ID = '00000000-0000-0000-0000-000000000000';

export type ReconciliationFindingInput = {
  runId: string;
  providerName: string;
  kind: WalletReconciliationFindingKind;
  currency?: string | null;
  network?: string | null;
  amount?: string | null;
  address?: string | null;
  tag?: string | null;
  txHash?: string | null;
  /**
   * The dedup key: a partial unique index on (kind, externalId) makes a duplicate
   * insert for the same underlying vendor event or job re-run a silent no-op. Pass a
   * stable stand-in (eg the source row's own id) when no vendor externalId exists, so
   * a finding with no natural external reference still dedupes across re-runs.
   */
  externalId?: string | null;
  transactionId?: string | null;
  detail?: string | null;
};

/**
 * The single write path for a reconciliation finding - never a raw `insert` scattered
 * across WalletService and ReconciliationService (both import this, neither imports the
 * other, so there is no cycle). A finding is a report, never a credit instruction (see
 * the schema's own comment): this never touches a balance or a transaction row, only
 * records that something needs a human look.
 */
export async function recordReconciliationFinding(
  db: DrizzleDb | DrizzleTx,
  input: ReconciliationFindingInput,
  audit?: AuditWritePort,
): Promise<void> {
  const [row] = await db
    .insert(walletReconciliationFinding)
    .values({
      runId: input.runId,
      providerName: input.providerName,
      kind: input.kind,
      currency: input.currency ?? null,
      network: input.network ?? null,
      amount: input.amount ?? null,
      address: input.address ?? null,
      tag: input.tag ?? null,
      txHash: input.txHash ?? null,
      externalId: input.externalId ?? null,
      transactionId: input.transactionId ?? null,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (row && audit) {
    const { address: _address, tag: _tag, txHash: _txHash, ...auditable } = input;
    await audit.record({
      actorType: 'system',
      action: 'wallet.reconciliation_finding.recorded',
      resourceType: 'wallet_reconciliation_finding',
      resourceId: row.id,
      after: auditable,
    });
  }
}
