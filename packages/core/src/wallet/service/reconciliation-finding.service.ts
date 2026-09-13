import { createLogger, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import type {
  AuditWritePort,
  RgLimitDecision,
  RgLimitsPort,
  User,
  WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import { walletReconciliationFinding } from '../schema/index.js';

const logger = createLogger('wallet-finding');

/**
 * Sentinel `runId` for a finding produced OUTSIDE any reconciliation job cycle: the live
 * webhook path (`WalletService.creditDepositByAddress`) hits an unattributable deposit in
 * real time rather than on a poll, and an admin resolving a finding acts on their own
 * clock. `runId` is NOT NULL on the table, so this fixed zero-uuid documents "no job run
 * owns this row", mirroring the audit plugin's SYSTEM_ACTOR sentinel for "no admin acted
 * here".
 */
export const OUT_OF_CYCLE_RUN_ID = '00000000-0000-0000-0000-000000000000';

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
   * The dedup key: a partial unique index on (kind, providerName, externalId) makes a duplicate
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

/**
 * The deposit gate asked about money that has ALREADY reached the player: an on-chain
 * deposit a webhook credited, or one an admin credited by hand to resolve a finding.
 * Neither can be refused the way a PSP charge is (`docs/standards/compliance.md`: an
 * on-chain deposit is credited and flagged, never refused), so a breach becomes an
 * `rg_limit_breach` finding the caller files rather than an error.
 *
 * `attempted` is the part of the move the gate has NOT counted yet: `0` once the deposit
 * row is committed, because the gate already reads it out of the player's window, and the
 * credited amount for a `manual_credit`, which no deposit window counts.
 *
 * Returns `null` - never throws, never refuses - when the port is unbound, the limit is
 * intact, or the gate itself fails: the money moved before this ran, so a failure here is
 * a missed report, not a stuck deposit. `db` is a bare handle, not a transaction, for
 * that same reason; note that this makes the gate's own `pg_advisory_xact_lock` release
 * at statement end, which is harmless for a report and would NOT be for an enforcing
 * caller.
 */
export async function rgDecisionForLandedCredit(
  db: DrizzleDb,
  rgLimits: RgLimitsPort | undefined,
  move: { userId: User['id']; attempted: string; currency: string },
  context: { externalId?: string | null; txHash?: string | null },
): Promise<Extract<RgLimitDecision, { allowed: false }> | null> {
  if (!rgLimits) {
    return null;
  }
  let decision: RgLimitDecision;
  try {
    decision = await rgLimits.checkDeposit(db, move.userId, move.attempted, move.currency);
  } catch (err) {
    logger.error(
      { err, ...move, ...context },
      'RG limit check failed for money already credited - leaving the credit unchecked',
    );
    return null;
  }
  return decision.allowed ? null : decision;
}
