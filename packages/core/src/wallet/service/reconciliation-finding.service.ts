import { and, eq, isNull, sql } from 'drizzle-orm';
import { createLogger, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import type {
  AuditWritePort,
  RgLimitDecision,
  RgLimitsPort,
  User,
  WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import {
  walletReconciliationFinding,
  walletRefundedDeposit,
  type WalletReconciliationFinding as WalletReconciliationFindingRow,
  type WalletRefundedDeposit,
} from '../schema/index.js';

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
  sourceAddress?: string | null;
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
 * records that something needs a human look. True when it filed a new finding, false when the
 * report was already on file.
 */
export async function recordReconciliationFinding(
  db: DrizzleDb | DrizzleTx,
  input: ReconciliationFindingInput,
  audit?: AuditWritePort,
): Promise<boolean> {
  const row = await insertFinding(db, input);
  if (row && audit) {
    await audit.record(findingRecordedAudit(row.id, input));
  } else if (!row && audit) {
    await fillUnreadableFinding(db, input, audit);
  }
  return row !== undefined;
}

/** As `recordReconciliationFinding`, with the audit row committed in the caller's transaction. */
export async function recordReconciliationFindingInTransaction(
  txn: DrizzleTx,
  input: ReconciliationFindingInput,
  audit: AuditWritePort,
): Promise<boolean> {
  const row = await insertFinding(txn, input);
  if (row) {
    await audit.recordInTransaction(txn, findingRecordedAudit(row.id, input));
  }
  return row !== undefined;
}

/**
 * A poll that could not read a deposit's amount files `missing_deposit` with no amount, which
 * takes the deposit's only slot in the unique index. The first readable report completes that
 * row instead of being dropped by the conflict, or by `SAME_DEPOSIT_KIND` for a webhook.
 */
async function fillUnreadableFinding(
  db: DrizzleDb | DrizzleTx,
  input: ReconciliationFindingInput,
  audit: AuditWritePort,
): Promise<void> {
  const { amount, externalId } = input;
  if (!amount || !externalId || !SAME_DEPOSIT_KIND[input.kind]) {
    return;
  }
  const filled = {
    amount,
    currency: input.currency ?? null,
    network: input.network ?? null,
    address: input.address ?? null,
    tag: input.tag ?? null,
    txHash: input.txHash ?? null,
    sourceAddress: input.sourceAddress ?? null,
    detail: null,
  };
  const stillUnreadable = and(
    eq(walletReconciliationFinding.kind, 'missing_deposit'),
    eq(walletReconciliationFinding.providerName, input.providerName),
    eq(walletReconciliationFinding.externalId, externalId),
    eq(walletReconciliationFinding.status, 'open'),
    isNull(walletReconciliationFinding.amount),
  );
  await db.transaction(async (txn) => {
    if (await isRefundedDeposit(txn, input.providerName, externalId)) {
      return;
    }
    const [row] = await txn
      .select({
        id: walletReconciliationFinding.id,
        amount: walletReconciliationFinding.amount,
        currency: walletReconciliationFinding.currency,
        network: walletReconciliationFinding.network,
        address: walletReconciliationFinding.address,
        detail: walletReconciliationFinding.detail,
      })
      .from(walletReconciliationFinding)
      .where(stillUnreadable)
      .for('update');
    if (!row) {
      return;
    }
    await txn.update(walletReconciliationFinding).set(filled).where(stillUnreadable);
    const { id, address, ...before } = row;
    const recorded = findingRecordedAudit(id, input);
    const { kind: _kind, runId: _runId, ...reported } = recorded.after;
    await audit.recordInTransaction(txn, {
      ...recorded,
      action: 'wallet.reconciliation_finding.filled',
      before,
      after: { ...reported, detail: null, addressChanged: address !== filled.address },
    });
  });
}

function findingRecordedAudit(
  findingId: WalletReconciliationFindingRow['id'],
  input: ReconciliationFindingInput,
) {
  const {
    address: _address,
    tag: _tag,
    txHash: _txHash,
    sourceAddress: _sourceAddress,
    ...auditable
  } = input;
  return {
    actorType: 'system' as const,
    action: 'wallet.reconciliation_finding.recorded',
    resourceType: 'wallet_reconciliation_finding',
    resourceId: findingId,
    after: auditable,
  };
}

/** Findings about on-chain money that reached custody for a player (or should have). */
export const DEPOSIT_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'missing_deposit',
  'unattributed_deposit',
  'amount_mismatch',
  'currency_mismatch',
  'held_deposit',
  'below_minimum_deposit',
]);

/** Whether an admin already refunded this vendor deposit on chain, from any finding. */
export async function isRefundedDeposit(
  db: DrizzleDb | DrizzleTx,
  providerName: WalletRefundedDeposit['providerName'],
  externalId: WalletRefundedDeposit['externalId'],
): Promise<boolean> {
  const [row] = await db
    .select({ id: walletRefundedDeposit.id })
    .from(walletRefundedDeposit)
    .where(
      and(
        eq(walletRefundedDeposit.providerName, providerName),
        eq(walletRefundedDeposit.externalId, externalId),
      ),
    );
  return row !== undefined;
}

/**
 * Serializes every move of one vendor deposit's money (a webhook credit, an admin credit,
 * release or refund) for the rest of the transaction. Without it a refund and a credit of the
 * same deposit, each checking the other's absence first, could both commit and pay it twice.
 */
export async function lockVendorDeposit(
  txn: DrizzleTx,
  providerName: WalletRefundedDeposit['providerName'],
  externalId: WalletRefundedDeposit['externalId'],
): Promise<void> {
  const key = `wallet-vendor-deposit:${providerName}:${externalId}`;
  await txn.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

const SAME_DEPOSIT_KIND: Partial<
  Record<WalletReconciliationFindingKind, WalletReconciliationFindingKind>
> = {
  missing_deposit: 'unattributed_deposit',
  unattributed_deposit: 'missing_deposit',
};

async function hasFinding(
  db: DrizzleDb | DrizzleTx,
  kind: WalletReconciliationFindingKind,
  providerName: WalletReconciliationFindingRow['providerName'],
  externalId: NonNullable<WalletReconciliationFindingRow['externalId']>,
): Promise<boolean> {
  const [row] = await db
    .select({ id: walletReconciliationFinding.id })
    .from(walletReconciliationFinding)
    .where(
      and(
        eq(walletReconciliationFinding.kind, kind),
        eq(walletReconciliationFinding.providerName, providerName),
        eq(walletReconciliationFinding.externalId, externalId),
      ),
    );
  return row !== undefined;
}

async function insertFinding(db: DrizzleDb | DrizzleTx, input: ReconciliationFindingInput) {
  // A refunded deposit is settled: a redelivery or re-poll of it must not reopen it as a
  // finding of another kind an admin could refund or credit a second time.
  if (
    DEPOSIT_FINDING_KINDS.has(input.kind) &&
    input.externalId &&
    (await isRefundedDeposit(db, input.providerName, input.externalId))
  ) {
    logger.warn(
      { kind: input.kind, providerName: input.providerName, externalId: input.externalId },
      'reconciliation finding not filed: the deposit was already refunded on chain',
    );
    return undefined;
  }
  // A deposit to an address we never issued is both unattributable (webhook) and missing
  // from the ledger (poll). Whichever files first owns it, open or resolved - a second one
  // would double the alert count, and reopen a deposit an admin already dismissed.
  const sameDepositKind = SAME_DEPOSIT_KIND[input.kind];
  if (
    sameDepositKind &&
    input.externalId &&
    (await hasFinding(db, sameDepositKind, input.providerName, input.externalId))
  ) {
    return undefined;
  }
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
      sourceAddress: input.sourceAddress ?? null,
      externalId: input.externalId ?? null,
      transactionId: input.transactionId ?? null,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row;
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
