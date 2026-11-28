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
  externalId?: string | null;
  transactionId?: string | null;
  detail?: string | null;
};

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

export async function recordReconciliationFindingsInTransaction(
  txn: DrizzleTx,
  inputs: readonly ReconciliationFindingInput[],
  audit: AuditWritePort,
): Promise<ReconciliationFindingInput[]> {
  if (inputs.length === 0) {
    return [];
  }
  const keyOf = (f: Pick<ReconciliationFindingInput, 'kind' | 'providerName' | 'externalId'>) =>
    `${f.kind}:${f.providerName}:${f.externalId}`;
  const byKey = new Map(inputs.map((input) => [keyOf(input), input]));
  const filed = await txn
    .insert(walletReconciliationFinding)
    .values(inputs.map(findingValues))
    .onConflictDoNothing()
    .returning({
      id: walletReconciliationFinding.id,
      kind: walletReconciliationFinding.kind,
      providerName: walletReconciliationFinding.providerName,
      externalId: walletReconciliationFinding.externalId,
    });
  const recorded: ReconciliationFindingInput[] = [];
  for (const row of filed) {
    const input = byKey.get(keyOf(row));
    if (input) {
      await audit.recordInTransaction(txn, findingRecordedAudit(row.id, input));
      recorded.push(input);
    }
  }
  return recorded;
}

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

export const DEPOSIT_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'missing_deposit',
  'unattributed_deposit',
  'amount_mismatch',
  'currency_mismatch',
  'held_deposit',
  'below_minimum_deposit',
]);

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
    .values(findingValues(input))
    .onConflictDoNothing()
    .returning();
  return row;
}

export function findingValues(input: ReconciliationFindingInput) {
  return {
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
  };
}

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
