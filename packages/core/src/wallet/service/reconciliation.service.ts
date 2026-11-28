import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notLike,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
  createDomainError,
  createLogger,
  makeConflictError,
  makeNotFoundError,
  isPositiveMoney,
  oldestUnrelayedEvent,
  moneyCompare,
  moneyEquals,
  moneySubtract,
  pageToOffset,
  serializeRow,
} from '@openora/core/server';
import {
  DEFAULT_PAYMENT_PROVIDER,
  type AuditWritePort,
  type ClientMeta,
  type MessageBrokerAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type PlatformConfig,
  type RgLimitsPort,
  type User,
  type WalletJobRunStatus,
  type WalletDepositStatusEventStatus,
  type WalletReconciliationFindingKind,
  queue,
  UuidSchema,
} from '@openora/core/contracts';
import {
  ledgerApiRequest,
  wallet,
  walletCustodySweep,
  walletDepositStatusEvent,
  walletJobRun,
  walletReconciliationFinding,
  walletRefundedDeposit,
  walletTransaction,
  type Wallet,
  type WalletJobRun,
  type WalletReconciliationFinding as WalletReconciliationFindingRow,
  type WalletTransaction,
} from '../schema/index.js';
import type {
  ListReconciliationFindingsInput,
  ReconciliationResolution,
  WalletReconciliationFinding as WalletReconciliationFindingDto,
} from '../contract/index.js';
import {
  DepositAlreadyOnLedgerError,
  HeldDepositNotFoundError,
  type WalletService,
  depositStatusIsNoOp,
  isRecordableDeposit,
} from './wallet.service.js';
import type { ProjectionComparison } from './ledger-play-eligibility.service.js';
import {
  DEPOSIT_FINDING_KINDS,
  OUT_OF_CYCLE_RUN_ID,
  isRefundedDeposit,
  lockVendorDeposit,
  recordReconciliationFinding,
  recordReconciliationFindingsInTransaction,
  type ReconciliationFindingInput,
  rgDecisionForLandedCredit,
} from './reconciliation-finding.service.js';
import {
  LEDGER_FINDING_LABEL,
  backfillBaselinePage,
  backfillMismatchKey,
  checkLedgerPage,
  ledgerBreachKey,
  ledgerPairKey,
  ledgerUncheckedDetail,
  ledgerUncheckedKey,
  lockAndCheckLedgerPair,
  type BaselineMove,
  type LedgerPairCheck,
  type LedgerPairState,
  parseLedgerBreachKey,
  parseLedgerUncheckedKey,
  lockAndEstimateBackfill,
  parseBalanceAtFiling,
  parseLedgerPairKey,
  rebaselinePair,
  SWAP_DESK_PROVIDER_LABEL,
} from './ledger-invariant.service.js';

const logger = createLogger('wallet-reconciliation');

export const ReconciliationFindingNotFoundError = makeNotFoundError('ReconciliationFinding');

export const ReconciliationCreditTransactionNotFoundError = makeNotFoundError(
  'ReconciliationCreditTransaction',
);

export const ReconciliationCreditMismatchError = makeConflictError(
  'ReconciliationCreditMismatchError',
  "The referenced transaction is not a manual credit matching this finding's currency and amount",
);

export const DepositAlreadyRefundedError = makeConflictError(
  'DepositAlreadyRefundedError',
  'This deposit was already refunded on chain and cannot be refunded or credited again',
);

export const ReconciliationRefundAmountError = createDomainError<
  [refunded: string, deposited: string | null]
>(
  'ReconciliationRefundAmountError',
  (refunded, deposited) =>
    `A refund of ${refunded} does not match the ${deposited ?? 'unknown'} this finding is about`,
);

export const ReconciliationAttributionError = createDomainError<[reason: string]>(
  'ReconciliationAttributionError',
  (reason) => `The deposit cannot be credited to this player: ${reason}`,
);

export type ReconciliationRefusalReason =
  | 'outcome_not_allowed_for_kind'
  | 'deposit_credit_names_a_transaction'
  | 'credit_names_no_transaction'
  | 'withdrawal_not_processing'
  | 'swap_not_processing'
  | 'refund_destination_without_note'
  | 'refund_without_vendor_id'
  | 'ledger_deposit_not_completed'
  | 'not_a_ledger_pair'
  | 'unpriced_rows_after_cut'
  | 'credit_already_used'
  | 'baseline_moved'
  | 'drift_changed'
  | 'pair_not_clean';

export class ReconciliationOutcomeNotAllowedError extends Error {
  readonly data: { reason: ReconciliationRefusalReason };

  constructor(
    kind: WalletReconciliationFindingKind,
    outcome: ReconciliationResolution['outcome'],
    reason: ReconciliationRefusalReason = 'outcome_not_allowed_for_kind',
  ) {
    super(`A ${kind} finding cannot be resolved as ${outcome}: ${reason}`);
    this.name = 'ReconciliationOutcomeNotAllowedError';
    this.data = { reason };
  }
}

const REFUNDABLE_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'held_deposit',
  'missing_deposit',
  'unattributed_deposit',
  'below_minimum_deposit',
]);

const LEDGER_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'ledger_invariant_breach',
  'ledger_invariant_unchecked',
]);

const SUPER_ADMIN_DISMISSAL_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  ...LEDGER_FINDING_KINDS,
  'ledger_request_mismatch',
  'ledger_unrequested_transaction',
]);

const DISMISS_ONLY_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'stuck_withdrawal_requested',
  'stuck_withdrawal_approved',
  'stuck_withdrawal_processing',
  'ledger_request_mismatch',
  'ledger_unrequested_transaction',
  'rg_limit_breach',
  'stuck_sweep',
  'unconfigured_asset',
  'play_eligibility_drift',
  'rg_limits_drift',
  'outbox_relay_lag',
  'event_dead_letters',
]);

type HeldRowType = 'withdrawal' | 'swap_out';

const HELD_ROW_SETTLED_BY_CREDIT: Partial<
  Record<
    WalletReconciliationFindingKind,
    { type: HeldRowType; refusal: ReconciliationRefusalReason }
  >
> = {
  unknown_at_provider: { type: 'withdrawal', refusal: 'withdrawal_not_processing' },
  stuck_swap: { type: 'swap_out', refusal: 'swap_not_processing' },
};

export function assertOutcomeAllowed(
  kind: WalletReconciliationFindingKind,
  outcome: ReconciliationResolution['outcome'],
): void {
  const allowed =
    kind === 'held_deposit'
      ? outcome === 'released' || outcome === 'refunded'
      : DISMISS_ONLY_FINDING_KINDS.has(kind)
        ? outcome === 'dismissed'
        : LEDGER_FINDING_KINDS.has(kind)
          ? outcome === 'rebaselined' || outcome === 'dismissed'
          : outcome === 'credited' ||
            outcome === 'dismissed' ||
            (outcome === 'refunded' && REFUNDABLE_FINDING_KINDS.has(kind));
  if (!allowed) {
    throw new ReconciliationOutcomeNotAllowedError(kind, outcome);
  }
}

async function assertLedgerFindingStands(
  txn: DrizzleTx,
  finding: WalletReconciliationFindingRow,
  pair: { walletId: Wallet['id']; currency: string },
): Promise<void> {
  const refuse = (reason: ReconciliationRefusalReason) =>
    new ReconciliationOutcomeNotAllowedError(finding.kind, 'rebaselined', reason);
  const isBreach = finding.kind === 'ledger_invariant_breach';
  const breach = isBreach ? parseLedgerBreachKey(finding.externalId) : null;
  const filed = isBreach ? breach : parseLedgerUncheckedKey(finding.externalId);
  if (!filed) {
    throw refuse('not_a_ledger_pair');
  }
  if ('backfillDrift' in filed) {
    const now = await lockAndEstimateBackfill(txn, pair.walletId, pair.currency);
    if (!now) {
      throw refuse('not_a_ledger_pair');
    }
    if (now.baselineId !== null) {
      throw refuse('baseline_moved');
    }
    if (now.drift === null || !moneyEquals(now.drift, filed.backfillDrift)) {
      throw refuse('drift_changed');
    }
    return;
  }
  const now = await lockAndCheckLedgerPair(txn, pair.walletId, pair.currency);
  if (!now) {
    throw refuse('not_a_ledger_pair');
  }
  if (now.baselineId !== filed.baselineId) {
    throw refuse('baseline_moved');
  }
  if (breach && !moneyEquals(now.drift, breach.drift)) {
    throw refuse('drift_changed');
  }
}

const backfillDriftOf = (finding: WalletReconciliationFindingRow): string | undefined => {
  const filed =
    finding.kind === 'ledger_invariant_unchecked'
      ? parseLedgerUncheckedKey(finding.externalId)
      : null;
  return filed && 'backfillDrift' in filed ? filed.backfillDrift : undefined;
};

type PlainUncheckedFiling = {
  balanceAtFiling: string | null;
  openBackfillFlags: { externalId: string; drift: string }[];
};

async function plainUncheckedFiling(
  txn: DrizzleTx,
  finding: WalletReconciliationFindingRow,
  pair: { walletId: Wallet['id']; currency: string },
): Promise<PlainUncheckedFiling | undefined> {
  const filed =
    finding.kind === 'ledger_invariant_unchecked'
      ? parseLedgerUncheckedKey(finding.externalId)
      : null;
  if (!filed || 'backfillDrift' in filed) {
    return undefined;
  }
  const flags = await txn
    .select({ externalId: walletReconciliationFinding.externalId })
    .from(walletReconciliationFinding)
    .where(
      and(
        eq(walletReconciliationFinding.status, 'open'),
        eq(walletReconciliationFinding.kind, 'ledger_invariant_unchecked'),
        eq(walletReconciliationFinding.providerName, LEDGER_FINDING_LABEL),
        sql`starts_with(${walletReconciliationFinding.externalId}, ${`${ledgerPairKey(pair.walletId, pair.currency)}:backfill:`})`,
      ),
    );
  return {
    balanceAtFiling: parseBalanceAtFiling(finding.detail),
    openBackfillFlags: flags.flatMap(({ externalId }) => {
      const flag = parseLedgerUncheckedKey(externalId);
      return externalId && flag && 'backfillDrift' in flag
        ? [{ externalId, drift: flag.backfillDrift }]
        : [];
    }),
  };
}

async function settleCleanLedgerPair(
  txn: DrizzleTx,
  finding: WalletReconciliationFindingRow,
): Promise<{ check: LedgerPairState; baseline: BaselineMove | null }> {
  const pair = parseLedgerPairKey(finding.externalId);
  const check = pair && (await lockAndCheckLedgerPair(txn, pair.walletId, pair.currency));
  const breach = finding.kind === 'ledger_invariant_breach';
  const refuse = (reason: ReconciliationRefusalReason) =>
    new ReconciliationOutcomeNotAllowedError(finding.kind, 'dismissed', reason);
  if (!pair || !check || check.unpricedRows > 0 || (breach && !moneyEquals(check.drift, '0'))) {
    throw refuse('pair_not_clean');
  }
  if (!breach) {
    return { check, baseline: null };
  }
  const baseline = await rebaselinePair(txn, pair.walletId, pair.currency, finding.id);
  if (!baseline) {
    throw refuse('unpriced_rows_after_cut');
  }
  return { check, baseline };
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type LedgerMatch = Pick<WalletTransaction, 'id' | 'currency' | 'amount' | 'network'>;

export function diffDeposit(
  event: Extract<PaymentWebhookEvent, { kind: 'deposit' }>,
  tx: LedgerMatch | undefined,
): 'missing_deposit' | 'currency_mismatch' | 'amount_mismatch' | null {
  if (!tx) {
    return 'missing_deposit';
  }
  if (tx.currency.toUpperCase() !== event.currency.toUpperCase()) {
    return 'currency_mismatch';
  }
  if (!moneyEquals(tx.amount, event.amount)) {
    return 'amount_mismatch';
  }
  return null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const PROVIDER_REF_LOOKUP_CHUNK_SIZE = 1000;

const DEFAULT_STALE_RUN_AFTER_MINUTES = 30;
const DEFAULT_LEDGER_INVARIANT_STALE_RUN_AFTER_MINUTES = 240;

const DEFAULT_UNKNOWN_AFTER_MINUTES = 60;

const STUCK_WITHDRAWAL_REQUESTED_AFTER_MINUTES = 24 * 60;

const PROJECTION_FINDING_LABEL = 'ledger-projection';
const EVENT_PIPELINE_FINDING_LABEL = 'event-pipeline';

const JOB_NAME = 'wallet-reconciliation';
const LEDGER_INVARIANT_JOB_NAME = 'wallet-ledger-invariant';
export const LEDGER_INVARIANT_QUEUE = queue(LEDGER_INVARIANT_JOB_NAME);
export const LedgerInvariantJobSchema = z.object({
  runId: UuidSchema.optional(),
  backfillBaselines: z.boolean().optional(),
});

type LedgerInvariantCounts = {
  baselinesInserted: number;
  baselinesSkipped: number;
  baselineMismatches: number;
  baselinesAdvanced: number;
  pairsChecked: number;
  needsBaseline: number;
  balanceBreaches: number;
  newBreaches: number;
};

const DEFAULT_BATCH_SIZE = 200;
const LEDGER_PAGE_MAX = 1000;

const MAX_CATCH_UP_MULTIPLE = 7;

type CreditedDeposit = {
  transactionId: WalletTransaction['id'];
  userId: User['id'];
  amount: string;
  currency: string;
};

function toFindingDto(row: WalletReconciliationFindingRow): WalletReconciliationFindingDto {
  return serializeRow(row, { dateFields: ['createdAt', 'resolvedAt'], decimalFields: [] });
}

type ProjectionDriftKind = Extract<
  WalletReconciliationFindingKind,
  'play_eligibility_drift' | 'rg_limits_drift'
>;

type OwnerSnapshot = { userId: string; version: number };

export type ProjectionDriftCheck = {
  kind: ProjectionDriftKind;
  page(after: string | null, limit: number): Promise<ProjectionDriftPage>;
  repair(userIds: readonly string[]): Promise<string[]>;
};

type ProjectionDriftPage = {
  snapshots: OwnerSnapshot[];
  behind: string[];
  conflicting: string[];
  catchUp(): Promise<unknown>;
};

export function projectionDriftCheck<S extends OwnerSnapshot>(
  kind: ProjectionDriftKind,
  source: {
    page(after: string | null, limit: number): Promise<S[]>;
    snapshots(userIds: readonly string[]): Promise<S[]>;
    repair(userIds: readonly string[]): Promise<string[]>;
  },
  projection: {
    compare(snapshots: readonly S[]): Promise<ProjectionComparison>;
    reconcile(snapshots: readonly S[]): Promise<number>;
  },
): ProjectionDriftCheck {
  return {
    kind,
    page: async (after, limit) => {
      const snapshots = await source.page(after, limit);
      const { behind, differing, ahead } = await projection.compare(snapshots);
      const stillAhead = new Set(
        ahead.length === 0 ? [] : (await projection.compare(await source.snapshots(ahead))).ahead,
      );
      const lagging = new Set(behind);
      return {
        snapshots,
        behind,
        conflicting: [...differing, ...ahead.filter((id) => stillAhead.has(id))],
        catchUp: () => projection.reconcile(snapshots.filter((s) => lagging.has(s.userId))),
      };
    },
    repair: (userIds) => source.repair(userIds),
  };
}

function noteFailure(
  counts: { failedChecks: string[] },
  check: string,
  context: Record<string, unknown>,
): void {
  if (!counts.failedChecks.includes(check)) {
    counts.failedChecks.push(check);
  }
  logger.error({ ...context, check }, 'reconciliation: a check failed, the run goes on');
}

export type ReconciliationServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  wallet: WalletService;
  paymentProviders: PaymentProviderRegistry;
  audit: AuditWritePort;
  platformConfig?: PlatformConfig;
  rgLimits?: RgLimitsPort;
  projectionChecks?: readonly ProjectionDriftCheck[];
  broker?: Pick<MessageBrokerAdapter, 'deadLetters'>;
};

export class ReconciliationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly wallet: WalletService;
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;
  private readonly rgLimits?: RgLimitsPort;
  private readonly projectionChecks: readonly ProjectionDriftCheck[];
  private readonly broker?: Pick<MessageBrokerAdapter, 'deadLetters'>;

  constructor({
    drizzle,
    events,
    wallet,
    paymentProviders,
    audit,
    platformConfig,
    rgLimits,
    projectionChecks = [],
    broker,
  }: ReconciliationServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.wallet = wallet;
    this.paymentProviders = paymentProviders;
    this.audit = audit;
    this.platformConfig = platformConfig;
    this.rgLimits = rgLimits;
    this.projectionChecks = projectionChecks;
    this.broker = broker;
  }

  async isLedgerFinding(id: WalletReconciliationFindingRow['id']): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ kind: walletReconciliationFinding.kind })
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.id, id));
    return row !== undefined && SUPER_ADMIN_DISMISSAL_KINDS.has(row.kind);
  }

  async listFindings(filter: ListReconciliationFindingsInput) {
    const db = this.drizzle.db;
    const conditions = [];
    if (filter.status) {
      conditions.push(eq(walletReconciliationFinding.status, filter.status));
    }
    if (filter.kind) {
      conditions.push(eq(walletReconciliationFinding.kind, filter.kind));
    }
    if (filter.providerName) {
      conditions.push(eq(walletReconciliationFinding.providerName, filter.providerName));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [{ n } = { n: 0 }]] = await Promise.all([
      db
        .select()
        .from(walletReconciliationFinding)
        .where(where)
        .orderBy(desc(walletReconciliationFinding.createdAt), desc(walletReconciliationFinding.id))
        .limit(filter.limit)
        .offset(pageToOffset(filter.page, filter.limit)),
      db.select({ n: count() }).from(walletReconciliationFinding).where(where),
    ]);

    return {
      items: rows.map(toFindingDto),
      total: Number(n),
      page: filter.page,
      limit: filter.limit,
    };
  }

  async resolveFinding(
    adminId: User['id'],
    id: WalletReconciliationFindingRow['id'],
    resolution: ReconciliationResolution,
    meta?: ClientMeta,
  ): Promise<WalletReconciliationFindingDto> {
    const { dto, credited } = await this.drizzle.db.transaction(async (txn) => {
      const [finding] = await txn
        .select()
        .from(walletReconciliationFinding)
        .where(eq(walletReconciliationFinding.id, id))
        .for('update');
      if (!finding) {
        throw new ReconciliationFindingNotFoundError(id);
      }
      if (finding.status !== 'open') {
        return { dto: toFindingDto(finding), credited: undefined };
      }
      assertOutcomeAllowed(finding.kind, resolution.outcome);
      if (DEPOSIT_FINDING_KINDS.has(finding.kind) && finding.externalId) {
        await lockVendorDeposit(txn, finding.providerName, finding.externalId);
      }

      let transactionId: string | undefined;
      let resolutionNote: string | null = null;
      let settledHeldRow: { id: string; type: HeldRowType } | null = null;
      let refundedDepositId: string | null = null;
      let creditedDeposit: CreditedDeposit | undefined;
      let releasedDeposit: CreditedDeposit | undefined;
      let baseline: BaselineMove | null = null;
      let cleanCheck: LedgerPairState | undefined;
      let filedDrift: string | undefined;
      let plainFiling: PlainUncheckedFiling | undefined;

      if (resolution.outcome === 'credited') {
        if (DEPOSIT_FINDING_KINDS.has(finding.kind)) {
          if (resolution.transactionId) {
            throw new ReconciliationOutcomeNotAllowedError(
              finding.kind,
              'credited',
              'deposit_credit_names_a_transaction',
            );
          }
          creditedDeposit = await this.creditDepositFinding(
            txn,
            finding,
            adminId,
            resolution.userId,
          );
          transactionId = creditedDeposit.transactionId;
        } else {
          if (!resolution.transactionId) {
            throw new ReconciliationOutcomeNotAllowedError(
              finding.kind,
              'credited',
              'credit_names_no_transaction',
            );
          }
          const [tx] = await txn
            .select()
            .from(walletTransaction)
            .where(eq(walletTransaction.id, resolution.transactionId))
            .for('update');
          if (!tx) {
            throw new ReconciliationCreditTransactionNotFoundError(resolution.transactionId);
          }
          if (
            tx.type !== 'manual_credit' ||
            finding.currency === null ||
            tx.currency.toUpperCase() !== finding.currency.toUpperCase() ||
            finding.amount === null ||
            !moneyEquals(tx.amount, finding.amount)
          ) {
            throw new ReconciliationCreditMismatchError();
          }
          const [claimed] = await txn
            .select({ id: walletReconciliationFinding.id })
            .from(walletReconciliationFinding)
            .where(eq(walletReconciliationFinding.transactionId, tx.id))
            .limit(1);
          if (claimed) {
            throw new ReconciliationOutcomeNotAllowedError(
              finding.kind,
              'credited',
              'credit_already_used',
            );
          }
          transactionId = tx.id;
          const held = HELD_ROW_SETTLED_BY_CREDIT[finding.kind];
          if (held) {
            const [heldRow] = finding.transactionId
              ? await txn
                  .select()
                  .from(walletTransaction)
                  .where(eq(walletTransaction.id, finding.transactionId))
                  .for('update')
              : [];
            if (heldRow?.type !== held.type || heldRow.status !== 'processing') {
              throw new ReconciliationOutcomeNotAllowedError(
                finding.kind,
                'credited',
                held.refusal,
              );
            }
            if (tx.walletId !== heldRow.walletId) {
              throw new ReconciliationCreditMismatchError();
            }
            settledHeldRow = { id: heldRow.id, type: held.type };
          }
        }
      } else if (resolution.outcome === 'released') {
        if (!finding.transactionId) {
          throw new HeldDepositNotFoundError();
        }
        const deposit = await this.wallet.releaseHeldDeposit(txn, finding.transactionId, adminId);
        releasedDeposit = { ...deposit, transactionId: finding.transactionId };
      } else if (resolution.outcome === 'refunded') {
        if (finding.amount === null || !moneyEquals(resolution.amount, finding.amount)) {
          throw new ReconciliationRefundAmountError(resolution.amount, finding.amount);
        }
        if (
          finding.sourceAddress !== null &&
          !sameAddress(finding.sourceAddress, resolution.destinationAddress) &&
          !resolution.note
        ) {
          throw new ReconciliationOutcomeNotAllowedError(
            finding.kind,
            'refunded',
            'refund_destination_without_note',
          );
        }
        await this.recordRefund(txn, finding);
        resolutionNote = [
          `refunded ${resolution.amount} ${finding.currency ?? ''} on chain in ${resolution.txHash} to ${resolution.destinationAddress}`,
          resolution.note,
        ]
          .filter(Boolean)
          .join(': ');
        if (finding.kind === 'held_deposit') {
          refundedDepositId = await this.markHeldDepositRefunded(
            txn,
            finding.transactionId,
            adminId,
          );
        } else if (finding.kind === 'missing_deposit' || finding.kind === 'below_minimum_deposit') {
          refundedDepositId = await this.recordMissingDepositRefunded(txn, finding, adminId);
        }
      } else if (resolution.outcome === 'rebaselined') {
        const pair = parseLedgerPairKey(finding.externalId);
        if (!pair) {
          throw new ReconciliationOutcomeNotAllowedError(
            finding.kind,
            'rebaselined',
            'not_a_ledger_pair',
          );
        }
        await assertLedgerFindingStands(txn, finding, pair);
        plainFiling = await plainUncheckedFiling(txn, finding, pair);
        baseline = await rebaselinePair(txn, pair.walletId, pair.currency, finding.id);
        if (!baseline) {
          throw new ReconciliationOutcomeNotAllowedError(
            finding.kind,
            'rebaselined',
            'unpriced_rows_after_cut',
          );
        }
        resolutionNote = resolution.note;
      } else {
        if (LEDGER_FINDING_KINDS.has(finding.kind)) {
          ({ check: cleanCheck, baseline } = await settleCleanLedgerPair(txn, finding));
          filedDrift = backfillDriftOf(finding);
        }
        resolutionNote = resolution.note;
      }

      const [row] = await txn
        .update(walletReconciliationFinding)
        .set({
          status: 'resolved',
          resolvedBy: adminId,
          resolvedAt: new Date(),
          resolutionNote,
          ...(transactionId ? { transactionId } : {}),
        })
        .where(eq(walletReconciliationFinding.id, id))
        .returning();
      if (!row) {
        throw new ReconciliationFindingNotFoundError(id);
      }

      if (settledHeldRow) {
        await txn
          .update(walletTransaction)
          .set({ status: 'failed' })
          .where(
            and(
              eq(walletTransaction.id, settledHeldRow.id),
              eq(walletTransaction.type, settledHeldRow.type),
              eq(walletTransaction.status, 'processing'),
            ),
          );
      }
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.reconciliation_finding.resolved',
        resourceType: 'wallet_reconciliation_finding',
        resourceId: row.id,
        before: {
          status: 'open',
          transactionId: finding.transactionId,
          ...(cleanCheck ? { check: cleanCheck } : {}),
          ...(filedDrift ? { filedDrift } : {}),
        },
        after: {
          status: row.status,
          outcome: resolution.outcome,
          transactionId: row.transactionId,
          resolutionNote: row.resolutionNote,
          closedWithdrawalId: settledHeldRow?.type === 'withdrawal' ? settledHeldRow.id : null,
          closedSwapId: settledHeldRow?.type === 'swap_out' ? settledHeldRow.id : null,
          releasedDepositId: releasedDeposit?.transactionId ?? null,
          creditedDeposit: creditedDeposit ?? null,
          refundedDepositId,
          ...(baseline ? { baseline } : {}),
          ...plainFiling,
          ...(resolution.outcome === 'refunded'
            ? {
                refundAmount: resolution.amount,
                refundCurrency: finding.currency,
                refundTxHash: resolution.txHash,
                refundDestinationAddress: resolution.destinationAddress,
                refundDestinationDiffersFromSource:
                  finding.sourceAddress === null
                    ? null
                    : !sameAddress(finding.sourceAddress, resolution.destinationAddress),
              }
            : {}),
        },
        ...meta,
      });
      const announced = creditedDeposit ?? releasedDeposit;
      if (announced) {
        await this.wallet.announceDepositCompleted(txn, announced);
      }
      return {
        dto: toFindingDto(row),
        credited: creditedDeposit
          ? { finding: row, deposit: creditedDeposit }
          : releasedDeposit
            ? { finding: undefined, deposit: releasedDeposit }
            : undefined,
      };
    });

    if (credited?.finding) {
      await this.recordRgBreachForHandCredit(credited.finding, credited.deposit);
    }
    return dto;
  }

  private async creditDepositFinding(
    txn: DrizzleTx,
    finding: WalletReconciliationFindingRow,
    adminId: User['id'],
    attributedUserId: User['id'] | undefined,
  ): Promise<CreditedDeposit> {
    if (finding.currency === null || finding.amount === null || !isPositiveMoney(finding.amount)) {
      throw new ReconciliationCreditMismatchError();
    }
    if (
      finding.externalId &&
      (await isRefundedDeposit(txn, finding.providerName, finding.externalId))
    ) {
      throw new DepositAlreadyRefundedError();
    }
    let owner: User['id'] | undefined;
    let amount = finding.amount;
    let providerRefId = finding.externalId;
    if (finding.transactionId) {
      const [ledger] = await txn
        .select({
          type: walletTransaction.type,
          status: walletTransaction.status,
          amount: walletTransaction.amount,
          currency: walletTransaction.currency,
          userId: wallet.userId,
        })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(eq(walletTransaction.id, finding.transactionId));
      if (
        finding.kind !== 'amount_mismatch' ||
        ledger?.type !== 'deposit' ||
        ledger.status !== 'completed' ||
        ledger.currency.toUpperCase() !== finding.currency.toUpperCase()
      ) {
        throw new ReconciliationOutcomeNotAllowedError(
          finding.kind,
          'credited',
          'ledger_deposit_not_completed',
        );
      }
      amount = moneySubtract(finding.amount, ledger.amount);
      if (moneyCompare(amount, '0') <= 0) {
        throw new ReconciliationCreditMismatchError();
      }
      owner = ledger.userId;
      providerRefId = null;
    } else if (finding.address) {
      owner = await this.wallet.depositAddressOwner({
        address: finding.address,
        network: finding.network ?? undefined,
        tag: finding.tag ?? undefined,
      });
    }
    if (attributedUserId && owner && attributedUserId !== owner) {
      throw new ReconciliationAttributionError('the deposit belongs to another player');
    }
    const userId = owner ?? attributedUserId;
    if (!userId) {
      throw new ReconciliationAttributionError('name the player it belongs to');
    }
    return this.wallet.creditDepositByHand(txn, {
      userId,
      adminId,
      amount,
      currency: finding.currency,
      network: finding.network,
      providerName: finding.providerName,
      providerRefId,
      address: finding.address,
      tag: finding.tag,
      txHash: finding.txHash,
    });
  }

  private async recordRefund(
    txn: DrizzleTx,
    finding: WalletReconciliationFindingRow,
  ): Promise<void> {
    if (!finding.externalId) {
      throw new ReconciliationOutcomeNotAllowedError(
        finding.kind,
        'refunded',
        'refund_without_vendor_id',
      );
    }
    if (finding.kind !== 'held_deposit') {
      const [onLedger] = await txn
        .select({ id: walletTransaction.id })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.providerName, finding.providerName),
            eq(walletTransaction.providerRefId, finding.externalId),
            eq(walletTransaction.type, 'deposit'),
          ),
        );
      if (onLedger) {
        throw new DepositAlreadyOnLedgerError();
      }
    }
    const [marked] = await txn
      .insert(walletRefundedDeposit)
      .values({
        providerName: finding.providerName,
        externalId: finding.externalId,
        findingId: finding.id,
      })
      .onConflictDoNothing()
      .returning({ id: walletRefundedDeposit.id });
    if (!marked) {
      throw new DepositAlreadyRefundedError();
    }
  }

  private async recordMissingDepositRefunded(
    txn: DrizzleTx,
    finding: WalletReconciliationFindingRow,
    adminId: User['id'],
  ): Promise<WalletTransaction['id'] | null> {
    if (
      !finding.address ||
      !finding.externalId ||
      finding.currency === null ||
      finding.amount === null
    ) {
      return null;
    }
    const userId = await this.wallet.depositAddressOwner({
      address: finding.address,
      network: finding.network ?? undefined,
      tag: finding.tag ?? undefined,
    });
    if (!userId) {
      return null;
    }
    return this.wallet.recordRefundedDeposit(txn, {
      userId,
      adminId,
      amount: finding.amount,
      currency: finding.currency,
      network: finding.network,
      providerName: finding.providerName,
      providerRefId: finding.externalId,
      address: finding.address,
      tag: finding.tag,
      txHash: finding.txHash,
    });
  }

  private async markHeldDepositRefunded(
    txn: DrizzleTx,
    depositId: WalletTransaction['id'] | null,
    adminId: User['id'],
  ): Promise<WalletTransaction['id']> {
    const [refunded] = depositId
      ? await txn
          .update(walletTransaction)
          .set({ status: 'refunded', reviewedBy: adminId, reviewedAt: sql`now()` })
          .where(
            and(
              eq(walletTransaction.id, depositId),
              eq(walletTransaction.type, 'deposit'),
              eq(walletTransaction.status, 'on_hold'),
            ),
          )
          .returning({ id: walletTransaction.id })
      : [];
    if (!refunded) {
      throw new HeldDepositNotFoundError();
    }
    return refunded.id;
  }

  private async recordRgBreachForHandCredit(
    finding: WalletReconciliationFindingRow,
    deposit: CreditedDeposit,
  ): Promise<void> {
    try {
      const decision = await rgDecisionForLandedCredit(
        this.drizzle.db,
        this.rgLimits,
        { userId: deposit.userId, attempted: '0', currency: deposit.currency },
        { externalId: finding.externalId, txHash: finding.txHash },
      );
      if (!decision) {
        return;
      }
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId: OUT_OF_CYCLE_RUN_ID,
          providerName: finding.providerName,
          kind: 'rg_limit_breach',
          currency: deposit.currency,
          network: finding.network,
          amount: deposit.amount,
          address: finding.address,
          tag: finding.tag,
          txHash: finding.txHash,
          externalId: finding.id,
          transactionId: deposit.transactionId,
          detail: `credited by hand past the player's ${decision.period} ${decision.limitType} limit of ${decision.limit} (${decision.used} in the window, this credit included) - resolving finding ${finding.id}`,
        },
        this.audit,
      );
    } catch (err) {
      logger.error(
        { err, findingId: finding.id, transactionId: deposit.transactionId },
        'RG breach finding for a hand-credited deposit could not be recorded',
      );
    }
  }

  private async resolveWindow(
    until: Date,
    lookbackHours: number,
  ): Promise<{ since: Date; unreconciledHours: number }> {
    const lookbackStart = new Date(until.getTime() - lookbackHours * 3_600_000);
    const [last] = await this.drizzle.db
      .select({ finishedAt: walletJobRun.finishedAt })
      .from(walletJobRun)
      .where(and(eq(walletJobRun.jobName, JOB_NAME), eq(walletJobRun.status, 'completed')))
      .orderBy(desc(walletJobRun.finishedAt))
      .limit(1);

    const anchor = last?.finishedAt;
    if (!anchor || anchor >= lookbackStart) {
      return { since: lookbackStart, unreconciledHours: 0 };
    }

    const floor = new Date(until.getTime() - lookbackHours * MAX_CATCH_UP_MULTIPLE * 3_600_000);
    const since = anchor < floor ? floor : anchor;
    return {
      since,
      unreconciledHours: Math.round((since.getTime() - anchor.getTime()) / 3_600_000),
    };
  }

  async runCycle(
    runId: WalletJobRun['runId'] = randomUUID(),
  ): Promise<{ runId: WalletJobRun['runId'] } | null> {
    const jobRunId = await this.claimRun(runId);
    if (!jobRunId) {
      return null;
    }

    const counts = {
      missingDeposit: 0,
      currencyMismatch: 0,
      amountMismatch: 0,
      withdrawalsReconciled: 0,
      unknownAtProvider: 0,
      stuckSweeps: 0,
      stuckSwaps: 0,
      stuckWithdrawals: 0,
      swapFindingsClosed: 0,
      withdrawalFindingsClosed: 0,
      ledgerRequestMismatches: 0,
      unrequestedLedgerMoves: 0,
      projectionDrifts: 0,
      projectionFindingsClosed: 0,
      deliveryIncidents: 0,
      failedChecks: [] as string[],
      projectionRepairsDeferred: 0,
      unreconciledHours: 0,
    };

    const cfg = this.platformConfig?.wallet?.reconciliation;
    const status = cfg ? 'completed' : 'skipped';
    let openFindings: number;
    try {
      if (cfg) {
        const until = new Date();
        const { since, unreconciledHours } = await this.resolveWindow(until, cfg.lookbackHours);
        counts.unreconciledHours = unreconciledHours;
        if (unreconciledHours > 0) {
          logger.error(
            { runId, unreconciledHours, since },
            'wallet reconciliation: catch-up window capped, an earlier span stays unreconciled',
          );
        }

        let providerFailure: unknown;
        for (const providerName of this.paymentProviders.names()) {
          try {
            await this.reconcileProvider(runId, providerName, since, until, counts);
          } catch (err) {
            providerFailure ??= err;
            noteFailure(counts, `provider_diff:${providerName}`, { err, runId });
          }
        }

        counts.withdrawalFindingsClosed += await this.resolveMovedOnWithdrawalFindings();
        await this.reconcileStuckWithdrawals(runId, cfg.stuckAfterMinutes, cfg.batchSize, counts);
        await this.reportStuckRequestedWithdrawals(runId, cfg.batchSize, counts);

        counts.swapFindingsClosed += await this.resolveFindingsLeftBehind(
          'stuck_swap',
          sql`${walletTransaction.status} = 'processing'`,
          'settled_at_desk',
          'the desk settled this swap after it was reported',
        );
        await this.reconcileStuckSwaps(
          runId,
          cfg.stuckSwapAfterMinutes ?? cfg.stuckAfterMinutes,
          cfg.batchSize,
          counts,
        );

        await this.reconcileStuckSweeps(
          runId,
          this.platformConfig?.wallet?.sweep?.unknownAfterMinutes ?? DEFAULT_UNKNOWN_AFTER_MINUTES,
          cfg.batchSize,
          counts,
        );

        await this.runCheck(runId, 'ledger_request_mismatch', counts, () =>
          this.reconcileLedgerRequests(runId, since, until, cfg.batchSize, counts),
        );
        await this.runCheck(runId, 'ledger_unrequested_transaction', counts, () =>
          this.reportUnrequestedLedgerMoves(runId, since, until, cfg.batchSize, counts),
        );
        for (const check of this.projectionChecks) {
          await this.runCheck(runId, check.kind, counts, () =>
            this.reconcileProjection(runId, check, cfg.batchSize, counts),
          );
        }
        await this.runCheck(runId, 'outbox_relay_lag', counts, () =>
          this.reconcileOutboxLag(runId, cfg.outboxLagAlertMinutes, counts),
        );
        await this.runCheck(runId, 'event_dead_letters', counts, () =>
          this.reconcileDeadLetters(runId, cfg.deadLetterAlertThreshold, counts),
        );
        if (providerFailure !== undefined) {
          throw providerFailure;
        }
      }

      openFindings = await this.countOpenFindings();
      await this.drizzle.db.transaction(async (txn) => {
        await this.finishRun(jobRunId, status, { ...counts, openFindings }, txn);
        await this.audit.recordInTransaction(txn, {
          actorType: 'system',
          action: cfg ? 'wallet.reconciliation_run.completed' : 'wallet.reconciliation_run.skipped',
          resourceType: 'wallet_job_run',
          resourceId: runId,
          after: { runId, ...counts, openFindings },
        });
        if (cfg) {
          await this.alertIfDue(txn, runId, cfg.alertThreshold, openFindings, counts);
        }
      });
    } catch (err) {
      await this.finishRun(jobRunId, 'failed', {
        ...counts,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.reconciliation_run.failed',
        resourceType: 'wallet_job_run',
        resourceId: runId,
        after: { runId, ...counts },
      });
      if (cfg) {
        await this.drizzle.db.transaction(async (txn) =>
          this.alertIfDue(
            txn,
            runId,
            cfg.alertThreshold,
            await this.countOpenFindings(txn),
            counts,
          ),
        );
      }
      throw err;
    }

    if (cfg && openFindings > cfg.alertThreshold) {
      logger.error(
        { runId, openFindings, threshold: cfg.alertThreshold },
        'wallet reconciliation: open findings exceed threshold',
      );
    }

    return { runId };
  }

  private async alertIfDue(
    txn: DrizzleTx,
    runId: WalletJobRun['runId'],
    threshold: number,
    openFindings: number,
    {
      failedChecks,
      projectionRepairsDeferred,
    }: { failedChecks: string[]; projectionRepairsDeferred: number },
  ): Promise<void> {
    if (openFindings <= threshold && failedChecks.length === 0 && projectionRepairsDeferred === 0) {
      return;
    }
    await this.events.emitInTransaction(txn, 'wallet.reconciliation.alert', {
      runId,
      openFindings,
      threshold,
      ...(failedChecks.length > 0 && { failedChecks }),
      ...(projectionRepairsDeferred > 0 && { projectionRepairsDeferred }),
    });
  }

  async runLedgerInvariant(
    runId: WalletJobRun['runId'] = randomUUID(),
    { backfillBaselines = false }: { backfillBaselines?: boolean } = {},
  ): Promise<{ runId: WalletJobRun['runId'] } | null> {
    const jobRunId = await this.claimRun(
      runId,
      LEDGER_INVARIANT_JOB_NAME,
      this.platformConfig?.wallet?.reconciliation?.ledgerInvariantStaleRunAfterMinutes ??
        DEFAULT_LEDGER_INVARIANT_STALE_RUN_AFTER_MINUTES,
    );
    if (!jobRunId) {
      if (backfillBaselines) {
        await this.audit.record({
          actorType: 'system',
          action: 'wallet.ledger_invariant_run.skipped',
          resourceType: 'wallet_job_run',
          resourceId: runId,
          after: { runId, backfillBaselines, reason: 'another ledger invariant run is in flight' },
        });
      }
      return null;
    }
    const batchSize = Math.min(
      this.platformConfig?.wallet?.reconciliation?.batchSize ?? DEFAULT_BATCH_SIZE,
      LEDGER_PAGE_MAX,
    );
    const counts: LedgerInvariantCounts = {
      baselinesInserted: 0,
      baselinesSkipped: 0,
      baselineMismatches: 0,
      baselinesAdvanced: 0,
      pairsChecked: 0,
      needsBaseline: 0,
      balanceBreaches: 0,
      newBreaches: 0,
    };
    try {
      if (backfillBaselines) {
        await this.backfillBaselines(runId, batchSize, counts);
      }
      await this.checkWalletBalances(runId, batchSize, counts);
      await this.drizzle.db.transaction(async (txn) => {
        if (!(await this.finishRun(jobRunId, 'completed', counts, txn))) {
          return;
        }
        await this.audit.recordInTransaction(txn, {
          actorType: 'system',
          action: 'wallet.ledger_invariant_run.completed',
          resourceType: 'wallet_job_run',
          resourceId: runId,
          after: { runId, backfillBaselines, ...counts },
        });
      });
    } catch (err) {
      await this.finishRun(jobRunId, 'failed', {
        ...counts,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.ledger_invariant_run.failed',
        resourceType: 'wallet_job_run',
        resourceId: runId,
        after: { runId, backfillBaselines, ...counts },
      });
      throw err;
    }
    if (counts.newBreaches > 0) {
      logger.error(
        { runId, newBreaches: counts.newBreaches },
        'ledger invariant: wallet balances off their ledger',
      );
    }
    if (counts.needsBaseline > 0) {
      logger.warn(
        { runId, needsBaseline: counts.needsBaseline },
        'ledger invariant: wallets hold legacy rows and no baseline, run the baseline backfill',
      );
    }
    return { runId };
  }

  private async backfillBaselines(
    runId: WalletJobRun['runId'],
    batchSize: number,
    counts: LedgerInvariantCounts,
  ): Promise<void> {
    let afterId: string | null = null;
    for (;;) {
      const page = await backfillBaselinePage(this.drizzle.db, afterId, batchSize, runId);
      counts.baselinesInserted += page.inserted;
      counts.baselinesSkipped += page.skipped;
      for (const pair of page.mismatches) {
        counts.baselineMismatches += 1;
        const drift = moneySubtract(pair.amount, pair.estimate);
        await recordReconciliationFinding(
          this.drizzle.db,
          {
            runId,
            providerName: LEDGER_FINDING_LABEL,
            kind: 'ledger_invariant_unchecked',
            currency: pair.currency,
            externalId: backfillMismatchKey(pair.walletId, pair.currency, drift),
            detail: `wallet ${pair.walletId} would be baselined at ${pair.amount} ${pair.currency} (its balance less the rows after the cut) but its ledger last stamped a balance that carries forward to ${pair.estimate}, so it was not baselined`,
          },
          this.audit,
        );
      }
      if (page.scanned < batchSize || page.lastId === null) {
        return;
      }
      afterId = page.lastId;
    }
  }

  private async checkWalletBalances(
    runId: WalletJobRun['runId'],
    batchSize: number,
    counts: LedgerInvariantCounts,
  ): Promise<void> {
    let afterId: string | null = null;
    for (;;) {
      const page = await checkLedgerPage(this.drizzle.db, afterId, batchSize, runId);
      await this.closeBaselinedUnchecked(
        runId,
        page.filter(
          (pair) =>
            pair.unpricedRows === 0 && (pair.baselineId !== null || pair.advancedTo !== null),
        ),
      );
      const findings: ReconciliationFindingInput[] = [];
      for (const pair of page) {
        counts.pairsChecked += 1;
        if (pair.advancedTo !== null) {
          counts.baselinesAdvanced += 1;
        }
        if (pair.unpricedRows > 0) {
          counts.needsBaseline += 1;
          findings.push({
            runId,
            providerName: LEDGER_FINDING_LABEL,
            kind: 'ledger_invariant_unchecked',
            currency: pair.currency,
            externalId: ledgerUncheckedKey(pair.walletId, pair.currency, pair.baselineId),
            detail: ledgerUncheckedDetail(pair),
          });
          continue;
        }
        const drift = moneySubtract(pair.balance, pair.expected);
        if (moneyEquals(drift, '0')) {
          continue;
        }
        counts.balanceBreaches += 1;
        logger.error({ runId, ...pair, drift }, 'ledger invariant: wallet balance off its ledger');
        const amount = drift.replace(/^-/, '');
        findings.push({
          runId,
          providerName: LEDGER_FINDING_LABEL,
          kind: 'ledger_invariant_breach',
          currency: pair.currency,
          amount,
          externalId: ledgerBreachKey(pair.walletId, pair.currency, pair.baselineId, drift),
          detail: `wallet ${pair.walletId} holds ${pair.balance} ${pair.currency} but its ledger adds up to ${pair.expected}: the balance is ${drift.startsWith('-') ? 'short' : 'over'} by ${amount}`,
        });
      }
      counts.newBreaches += await this.fileLedgerFindings(runId, findings);
      const last = page.at(-1);
      if (page.length < batchSize || !last) {
        return;
      }
      afterId = last.id;
    }
  }

  private async closeBaselinedUnchecked(
    runId: WalletJobRun['runId'],
    pairs: readonly LedgerPairCheck[],
  ): Promise<void> {
    if (pairs.length === 0) {
      return;
    }
    const baselineOf = new Map(
      pairs.map((pair) => [
        ledgerPairKey(pair.walletId, pair.currency),
        pair.advancedTo ?? pair.baselineId,
      ]),
    );
    const pairKey = sql<string>`substring(${walletReconciliationFinding.externalId} from '^wallet:[^:]+:[^:]+')`;
    await this.drizzle.db.transaction(async (txn) => {
      const closed = await txn
        .update(walletReconciliationFinding)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNote: `baselined; checked by ledger invariant run ${runId}`,
        })
        .where(
          and(
            eq(walletReconciliationFinding.kind, 'ledger_invariant_unchecked'),
            eq(walletReconciliationFinding.providerName, LEDGER_FINDING_LABEL),
            eq(walletReconciliationFinding.status, 'open'),
            inArray(pairKey, [...baselineOf.keys()]),
            notLike(walletReconciliationFinding.externalId, '%:backfill:%'),
          ),
        )
        .returning({ id: walletReconciliationFinding.id, pairKey });
      for (const { id, pairKey: key } of closed) {
        await this.audit.recordInTransaction(txn, {
          actorType: 'system',
          action: 'wallet.reconciliation_finding.resolved',
          resourceType: 'wallet_reconciliation_finding',
          resourceId: id,
          before: { status: 'open' },
          after: {
            status: 'resolved',
            outcome: 'baselined',
            runId,
            baselineId: baselineOf.get(key) ?? null,
          },
        });
      }
    });
  }

  private async fileLedgerFindings(
    runId: WalletJobRun['runId'],
    findings: readonly ReconciliationFindingInput[],
  ): Promise<number> {
    return this.drizzle.db.transaction(async (txn) => {
      const filed = await recordReconciliationFindingsInTransaction(txn, findings, this.audit);
      const newBreaches = filed.filter((f) => f.kind === 'ledger_invariant_breach').length;
      if (newBreaches > 0) {
        await this.events.emitInTransaction(txn, 'wallet.reconciliation.alert', {
          runId,
          openFindings: await this.countOpenFindings(txn),
          threshold: 0,
        });
      }
      return newBreaches;
    });
  }

  private async reconcileProvider(
    runId: WalletJobRun['runId'],
    providerName: string,
    since: Date,
    until: Date,
    counts: {
      missingDeposit: number;
      currencyMismatch: number;
      amountMismatch: number;
      withdrawalsReconciled: number;
    },
  ): Promise<void> {
    const provider = this.paymentProviders.get(providerName);
    if (!provider?.adapter.listTransactions) {
      return;
    }
    const events = await provider.adapter.listTransactions({ since, until });

    const swept = await this.sweptExternalIds(providerName, since);
    const relevant = events.filter((event) => !swept.has(event.externalId));

    const deposits = relevant.filter(
      (event): event is Extract<PaymentWebhookEvent, { kind: 'deposit' }> =>
        event.kind === 'deposit',
    );
    const statuses = this.keepRecordable(
      relevant.filter(
        (event): event is Extract<PaymentWebhookEvent, { kind: 'deposit_status' }> =>
          event.kind === 'deposit_status',
      ),
      providerName,
    );
    const withdrawals = relevant.filter(
      (event): event is Extract<PaymentWebhookEvent, { kind: 'withdrawal' }> =>
        event.kind === 'withdrawal',
    );

    const externalIds = [...deposits, ...statuses].map((event) => event.externalId);
    const ledger = await this.batchLookupByProviderRefId(providerName, externalIds);
    const seen = await this.batchDepositStatusesSeen(providerName, externalIds);

    for (const event of statuses) {
      const statusesSeen = seen.get(event.externalId) ?? new Set();
      if (ledger.has(event.externalId) || depositStatusIsNoOp(statusesSeen, event.status)) {
        continue;
      }
      await this.wallet.recordDepositStatus(event);
    }

    await this.reconcileDeposits({ runId, providerName, deposits, ledger, seen, counts });

    for (const event of withdrawals) {
      await this.wallet.reconcileWithdrawalStatus(event, providerName);
      counts.withdrawalsReconciled += 1;
    }
  }

  private async sweptExternalIds(providerName: string, since: Date): Promise<Set<string>> {
    const rows = await this.drizzle.db
      .select({ externalId: walletCustodySweep.externalId })
      .from(walletCustodySweep)
      .where(
        and(
          eq(walletCustodySweep.providerName, providerName),
          gte(walletCustodySweep.createdAt, since),
        ),
      );
    return new Set(rows.map((row) => row.externalId).filter((id): id is string => id !== null));
  }

  private keepRecordable(
    events: readonly Extract<PaymentWebhookEvent, { kind: 'deposit_status' }>[],
    providerName: string,
  ) {
    return events.filter((event) => {
      if (isRecordableDeposit(event)) {
        return true;
      }
      logger.error(
        { providerName, externalId: event.externalId },
        'wallet reconciliation: malformed deposit status event skipped',
      );
      return false;
    });
  }

  private async fileUnreadableDeposit(
    runId: WalletJobRun['runId'],
    providerName: string,
    event: Extract<PaymentWebhookEvent, { kind: 'deposit' }>,
  ) {
    await recordReconciliationFinding(
      this.drizzle.db,
      {
        runId,
        providerName,
        kind: 'missing_deposit',
        currency: event.currency,
        network: event.network ?? null,
        amount: null,
        address: event.address,
        tag: event.tag ?? null,
        txHash: event.txHash,
        sourceAddress: event.sourceAddress ?? null,
        externalId: event.externalId,
        detail: `vendor reported an unreadable amount: ${[...String(JSON.stringify(event.amount))].slice(0, 200).join('')}`,
      },
      this.audit,
    );
  }

  private async reconcileDeposits({
    runId,
    providerName,
    deposits,
    ledger,
    seen,
    counts,
  }: {
    runId: WalletJobRun['runId'];
    providerName: string;
    deposits: readonly Extract<PaymentWebhookEvent, { kind: 'deposit' }>[];
    ledger: ReadonlyMap<string, WalletTransaction>;
    seen: ReadonlyMap<string, ReadonlySet<WalletDepositStatusEventStatus>>;
    counts: { missingDeposit: number; currencyMismatch: number; amountMismatch: number };
  }): Promise<void> {
    for (const event of deposits) {
      if (!isRecordableDeposit(event)) {
        if (event.externalId.trim() === '') {
          logger.error({ providerName }, 'wallet reconciliation: deposit with no id skipped');
        } else if (
          ledger.has(event.externalId) ||
          seen.get(event.externalId)?.has('below_minimum')
        ) {
          logger.error(
            { providerName, externalId: event.externalId },
            'wallet reconciliation: unreadable amount reported for a settled deposit, skipped',
          );
        } else {
          await this.fileUnreadableDeposit(runId, providerName, event);
          counts.missingDeposit += 1;
        }
        continue;
      }
      const tx = ledger.get(event.externalId);
      const result = diffDeposit(event, tx);
      if (result === null) {
        continue;
      }
      if (result === 'missing_deposit') {
        if (seen.get(event.externalId)?.has('below_minimum')) {
          continue;
        }
        const refused = await this.wallet.recordDepositIfBelowMinimum(event);
        if (refused) {
          continue;
        }
      }
      counts[
        result === 'missing_deposit'
          ? 'missingDeposit'
          : result === 'currency_mismatch'
            ? 'currencyMismatch'
            : 'amountMismatch'
      ] += 1;
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName,
          kind: result,
          currency: event.currency,
          network: event.network ?? tx?.network ?? null,
          amount: event.amount,
          address: event.address,
          tag: event.tag ?? null,
          txHash: event.txHash,
          sourceAddress: event.sourceAddress ?? null,
          externalId: event.externalId,
          transactionId: tx?.id ?? null,
          detail:
            result === 'currency_mismatch'
              ? `ledger currency ${tx?.currency}, vendor reported ${event.currency}`
              : result === 'amount_mismatch'
                ? `ledger amount ${tx?.amount}, vendor reported ${event.amount}`
                : null,
        },
        this.audit,
      );
    }
  }

  private async batchDepositStatusesSeen(
    providerName: string,
    externalIds: string[],
  ): Promise<Map<string, Set<WalletDepositStatusEventStatus>>> {
    const seen = new Map<string, Set<WalletDepositStatusEventStatus>>();
    for (const batch of chunk(externalIds, PROVIDER_REF_LOOKUP_CHUNK_SIZE)) {
      const rows = await this.drizzle.db
        .select({
          externalId: walletDepositStatusEvent.externalId,
          status: walletDepositStatusEvent.status,
        })
        .from(walletDepositStatusEvent)
        .where(
          and(
            eq(walletDepositStatusEvent.providerName, providerName),
            inArray(walletDepositStatusEvent.externalId, batch),
          ),
        );
      for (const { externalId, status } of rows) {
        seen.set(externalId, (seen.get(externalId) ?? new Set()).add(status));
      }
    }
    return seen;
  }

  private async batchLookupByProviderRefId(
    providerName: string,
    externalIds: string[],
  ): Promise<Map<string, WalletTransaction>> {
    const byExternalId = new Map<string, WalletTransaction>();
    for (const batch of chunk(externalIds, PROVIDER_REF_LOOKUP_CHUNK_SIZE)) {
      const rows = await this.drizzle.db
        .select()
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.providerName, providerName),
            inArray(walletTransaction.providerRefId, batch),
          ),
        );
      for (const row of rows) {
        if (row.providerRefId) {
          byExternalId.set(row.providerRefId, row);
        }
      }
    }
    return byExternalId;
  }

  private async reconcileStuckWithdrawals(
    runId: WalletJobRun['runId'],
    stuckAfterMinutes: number,
    batchSize: number,
    counts: { unknownAtProvider: number; stuckWithdrawals: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000);
    const alreadyReported = sql<boolean>`EXISTS (
      SELECT 1 FROM ${walletReconciliationFinding}
      WHERE ${walletReconciliationFinding.kind} IN
            ('unknown_at_provider', 'stuck_withdrawal_approved', 'stuck_withdrawal_processing')
        AND (${walletReconciliationFinding.kind} = 'stuck_withdrawal_approved')
            = (${walletTransaction.providerName} IS NULL)
        AND ${walletReconciliationFinding.providerName}
            = coalesce(${walletTransaction.providerName}, ${DEFAULT_PAYMENT_PROVIDER})
        AND ${walletReconciliationFinding.externalId}
            = coalesce(${walletTransaction.providerRefId}, ${walletTransaction.id}::text)
    )`;
    const stuck = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.status, 'processing'),
          eq(walletTransaction.type, 'withdrawal'),
          lt(
            sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`,
            cutoff,
          ),
        ),
      )
      .orderBy(asc(alreadyReported), asc(walletTransaction.createdAt))
      .limit(batchSize);

    for (const tx of stuck) {
      try {
        if (tx.providerName) {
          await this.reconcileStuckWithdrawal(runId, tx, counts);
        } else {
          await this.reportStuckWithdrawal(runId, tx, 'no provider recorded', counts);
          await this.wallet.requeueNeverDispatched(tx.id, cutoff);
        }
      } catch (err) {
        logger.error(
          { err, transactionId: tx.id },
          'reconciliation: stuck withdrawal check failed',
        );
        await this.reportStuckWithdrawal(runId, tx, 'status check failed', counts);
      }
    }
  }

  private async reportStuckWithdrawal(
    runId: WalletJobRun['runId'],
    tx: WalletTransaction,
    why: string,
    counts: { stuckWithdrawals: number },
  ): Promise<void> {
    try {
      const filed = await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName: tx.providerName ?? DEFAULT_PAYMENT_PROVIDER,
          kind: tx.providerName ? 'stuck_withdrawal_processing' : 'stuck_withdrawal_approved',
          currency: tx.currency,
          network: tx.network,
          amount: tx.amount,
          transactionId: tx.id,
          externalId: tx.providerRefId ?? tx.id,
          detail: `withdrawal processing since ${(tx.reviewedAt ?? tx.createdAt).toISOString()}; ${why}`,
        },
        this.audit,
      );
      if (filed) {
        counts.stuckWithdrawals += 1;
      }
    } catch (err) {
      logger.error({ err, transactionId: tx.id }, 'reconciliation: stuck withdrawal not filed');
    }
  }

  private async reconcileStuckWithdrawal(
    runId: WalletJobRun['runId'],
    tx: WalletTransaction,
    counts: { unknownAtProvider: number },
  ): Promise<void> {
    const providerName = tx.providerName ?? DEFAULT_PAYMENT_PROVIDER;
    const provider = this.paymentProviders.get(providerName);

    if (!tx.providerRefId) {
      const found = await provider?.adapter.findWithdrawalByReference?.(tx.id);
      if (found) {
        const recovered = await this.drizzle.db
          .update(walletTransaction)
          .set({ providerName, providerRefId: found.externalId })
          .where(
            and(
              eq(walletTransaction.id, tx.id),
              eq(walletTransaction.status, 'processing'),
              isNull(walletTransaction.providerRefId),
            ),
          )
          .returning({ id: walletTransaction.id });
        if (recovered.length === 0) {
          return;
        }
        await this.wallet.reconcileWithdrawalStatus(
          {
            kind: 'withdrawal',
            externalId: found.externalId,
            status: found.status,
            ...(found.txHash ? { txHash: found.txHash } : {}),
          },
          providerName,
        );
        return;
      }
      counts.unknownAtProvider += 1;
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName,
          kind: 'unknown_at_provider',
          currency: tx.currency,
          network: tx.network,
          amount: tx.amount,
          transactionId: tx.id,
          externalId: tx.id,
          detail: 'withdrawal has no providerRefId to look up at the vendor',
        },
        this.audit,
      );
      return;
    }

    const status = await provider?.adapter.getWithdrawalStatus?.(tx.providerRefId);
    if (status) {
      await this.wallet.reconcileWithdrawalStatus(
        {
          kind: 'withdrawal',
          externalId: tx.providerRefId,
          status: status.status,
          ...(status.txHash ? { txHash: status.txHash } : {}),
        },
        providerName,
      );
      return;
    }

    counts.unknownAtProvider += 1;
    await recordReconciliationFinding(
      this.drizzle.db,
      {
        runId,
        providerName,
        kind: 'unknown_at_provider',
        currency: tx.currency,
        network: tx.network,
        amount: tx.amount,
        transactionId: tx.id,
        externalId: tx.providerRefId,
        detail: 'vendor has no record of this withdrawal',
      },
      this.audit,
    );
  }

  private async resolveFindingsLeftBehind(
    kind: WalletReconciliationFindingKind,
    stillStuck: SQL,
    outcome: string,
    resolutionNote: string,
  ): Promise<number> {
    const left = sql`EXISTS (
      SELECT 1 FROM ${walletTransaction}
      WHERE ${walletTransaction.id} = ${walletReconciliationFinding.transactionId}
        AND NOT (${stillStuck})
    )`;
    try {
      return await this.drizzle.db.transaction((txn) =>
        this.closeFindings(txn, kind, left, outcome, resolutionNote),
      );
    } catch (err) {
      logger.error({ err, kind }, 'reconciliation: closing findings failed');
      return 0;
    }
  }

  private async closeFindings(
    txn: DrizzleTx,
    kind: WalletReconciliationFindingKind,
    where: SQL | undefined,
    outcome: string,
    resolutionNote: string,
  ): Promise<number> {
    const closed = await txn
      .update(walletReconciliationFinding)
      .set({ status: 'resolved', resolvedAt: new Date(), resolutionNote })
      .where(
        and(
          eq(walletReconciliationFinding.kind, kind),
          eq(walletReconciliationFinding.status, 'open'),
          where,
        ),
      )
      .returning({ id: walletReconciliationFinding.id });

    for (const row of closed) {
      await this.audit.recordInTransaction(txn, {
        actorType: 'system',
        action: 'wallet.reconciliation_finding.resolved',
        resourceType: 'wallet_reconciliation_finding',
        resourceId: row.id,
        before: { status: 'open' },
        after: { status: 'resolved', outcome },
      });
    }
    return closed.length;
  }

  private async runCheck(
    runId: WalletJobRun['runId'],
    name: string,
    counts: { failedChecks: string[] },
    check: () => Promise<void>,
  ): Promise<void> {
    try {
      await check();
    } catch (err) {
      noteFailure(counts, name, { err, runId });
    }
  }

  private async fileAndAlert(
    txn: DrizzleTx,
    runId: WalletJobRun['runId'],
    findings: readonly ReconciliationFindingInput[],
  ): Promise<number> {
    if (findings.length === 0) {
      return 0;
    }
    const [earlier] = await txn
      .select({ id: walletReconciliationFinding.id })
      .from(walletReconciliationFinding)
      .where(
        and(
          eq(walletReconciliationFinding.runId, runId),
          inArray(walletReconciliationFinding.kind, [...new Set(findings.map((f) => f.kind))]),
        ),
      )
      .limit(1);
    const filed = await recordReconciliationFindingsInTransaction(txn, findings, this.audit);
    if (filed.length > 0 && !earlier) {
      await this.events.emitInTransaction(txn, 'wallet.reconciliation.alert', {
        runId,
        openFindings: await this.countOpenFindings(txn),
        threshold: 0,
      });
    }
    return filed.length;
  }

  private async file(
    runId: WalletJobRun['runId'],
    findings: readonly ReconciliationFindingInput[],
  ): Promise<number> {
    return findings.length === 0
      ? 0
      : this.drizzle.db.transaction((txn) => this.fileAndAlert(txn, runId, findings));
  }

  private async reconcileLedgerRequests(
    runId: WalletJobRun['runId'],
    since: Date,
    until: Date,
    batchSize: number,
    counts: { ledgerRequestMismatches: number },
  ): Promise<void> {
    const request = ledgerApiRequest;
    const tx = walletTransaction;
    const answeredWith = sql`(${request.response} ->> 'transactionId')::uuid`;
    const answeredCurrency = sql`${request.response} ->> 'currency'`;
    const expectedType = sql`CASE ${request.operation}
      WHEN 'bet' THEN 'bet' WHEN 'win' THEN 'win' ELSE 'bet_reversal' END`;
    const mismatch = sql`(
      ${tx.id} IS NULL
      OR ${tx.type}::text <> ${expectedType}
      OR ${tx.currency} <> ${answeredCurrency}
      OR ${tx.providerName} IS DISTINCT FROM ${request.providerName}
      OR ${tx.providerRefId} IS DISTINCT FROM ${request.providerRefId}
      OR (${request.amount} IS NOT NULL AND ${tx.amount} <> ${request.amount})
      OR (${request.userId} IS NOT NULL AND ${wallet.userId} IS DISTINCT FROM ${request.userId})
    )`;
    let cursor: { at: string; providerName: string; providerRefId: string } | undefined;
    for (;;) {
      const rows = await this.drizzle.db
        .select({
          at: sql<string>`${request.createdAt}::text`,
          providerName: request.providerName,
          providerRefId: request.providerRefId,
          operation: request.operation,
          userId: request.userId,
          amount: request.amount,
          transactionId: sql<string>`${answeredWith}`,
          currency: sql<string>`${answeredCurrency}`,
          found: tx,
          foundUserId: wallet.userId,
        })
        .from(request)
        .leftJoin(tx, eq(tx.id, answeredWith))
        .leftJoin(wallet, eq(wallet.id, tx.walletId))
        .where(
          and(
            gte(request.createdAt, since),
            lt(request.createdAt, until),
            sql`${answeredWith} IS NOT NULL`,
            mismatch,
            cursor &&
              sql`(${request.createdAt}, ${request.providerName}, ${request.providerRefId})
                > (${cursor.at}::timestamptz, ${cursor.providerName}, ${cursor.providerRefId})`,
          ),
        )
        .orderBy(asc(request.createdAt), asc(request.providerName), asc(request.providerRefId))
        .limit(batchSize);
      counts.ledgerRequestMismatches += await this.file(
        runId,
        rows.map((row): ReconciliationFindingInput => {
          const found = row.found;
          const expected = row.operation === 'reverse' ? 'bet_reversal' : row.operation;
          const differs = found
            ? [
                found.type !== expected && `type ${found.type}`,
                found.currency !== row.currency && `currency ${found.currency}`,
                (found.providerName !== row.providerName ||
                  found.providerRefId !== row.providerRefId) &&
                  `key ${found.providerName}/${found.providerRefId}`,
                row.amount !== null &&
                  moneyCompare(found.amount, row.amount) !== 0 &&
                  `amount ${found.amount}`,
                row.userId !== null && row.foundUserId !== row.userId && `user ${row.foundUserId}`,
              ].filter((part) => part !== false)
            : [];
          return {
            runId,
            providerName: row.providerName,
            kind: 'ledger_request_mismatch',
            currency: row.currency,
            amount: row.amount,
            transactionId: found?.id ?? null,
            externalId: row.providerRefId,
            detail: found
              ? `${row.operation} answered ${row.transactionId}, which has ${differs.join(', ')}`
              : `${row.operation} answered ${row.transactionId}, which is not on the ledger`,
          };
        }),
      );
      const last = rows.at(-1);
      if (!last || rows.length < batchSize) {
        return;
      }
      cursor = last;
    }
  }

  private async reportUnrequestedLedgerMoves(
    runId: WalletJobRun['runId'],
    since: Date,
    until: Date,
    batchSize: number,
    counts: { unrequestedLedgerMoves: number },
  ): Promise<void> {
    const tx = walletTransaction;
    let cursor: { at: string; id: string } | undefined;
    for (;;) {
      const rows = await this.drizzle.db
        .select({ at: sql<string>`${tx.createdAt}::text`, row: tx })
        .from(tx)
        .where(
          and(
            gte(tx.createdAt, since),
            lt(tx.createdAt, until),
            inArray(tx.type, ['bet', 'win', 'bet_reversal']),
            sql`${tx.providerRefId} IS NOT NULL`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${ledgerApiRequest}
              WHERE ${ledgerApiRequest.providerName} = ${tx.providerName}
                AND ${ledgerApiRequest.providerRefId} = ${tx.providerRefId}
                AND ${ledgerApiRequest.userId} IS NOT NULL
            )`,
            sql`EXISTS (
              SELECT 1 FROM ${ledgerApiRequest}
              WHERE ${ledgerApiRequest.providerName} = ${tx.providerName}
                AND ${ledgerApiRequest.createdAt} <= ${tx.createdAt}
            )`,
            cursor && sql`(${tx.createdAt}, ${tx.id}) > (${cursor.at}::timestamptz, ${cursor.id})`,
          ),
        )
        .orderBy(asc(tx.createdAt), asc(tx.id))
        .limit(batchSize);
      counts.unrequestedLedgerMoves += await this.file(
        runId,
        rows.map(
          ({ row }): ReconciliationFindingInput => ({
            runId,
            providerName: row.providerName ?? '',
            kind: 'ledger_unrequested_transaction',
            currency: row.currency,
            amount: row.amount,
            transactionId: row.id,
            externalId: row.providerRefId,
            detail: `${row.type} ${row.id} moved with no Ledger API request under its key`,
          }),
        ),
      );
      const last = rows.at(-1);
      if (!last || rows.length < batchSize) {
        return;
      }
      cursor = { at: last.at, id: last.row.id };
    }
  }

  private async reconcileProjection(
    runId: WalletJobRun['runId'],
    check: ProjectionDriftCheck,
    batchSize: number,
    counts: {
      projectionDrifts: number;
      projectionFindingsClosed: number;
      projectionRepairsDeferred: number;
      failedChecks: string[];
    },
  ): Promise<void> {
    const userOf = sql<string>`split_part(${walletReconciliationFinding.externalId}, ':', 1)`;
    const reported = new Set(
      (
        await this.drizzle.db
          .select({ userId: userOf })
          .from(walletReconciliationFinding)
          .where(
            and(
              eq(walletReconciliationFinding.kind, check.kind),
              eq(walletReconciliationFinding.status, 'open'),
            ),
          )
      ).map((row) => row.userId),
    );
    let repairsLeft = batchSize;
    let attemptsLeft = 2 * batchSize;
    let deferred = 0;
    let after: string | null = null;
    for (;;) {
      const { snapshots, behind, conflicting, catchUp } = await check.page(after, batchSize);
      if (snapshots.length === 0) {
        break;
      }
      const drifting = [...behind, ...conflicting];
      const isDrifting = new Set(drifting);
      const inStep = snapshots
        .map((snapshot) => snapshot.userId)
        .filter((userId) => reported.has(userId) && !isDrifting.has(userId));
      const fresh = drifting.filter((userId) => !reported.has(userId));
      if (fresh.length > 0) {
        logger.error(
          { runId, kind: check.kind, players: fresh.length, behind: behind.length },
          'reconciliation: a ledger projection drifted from its owner; repairing',
        );
      }
      if (inStep.length > 0 || fresh.length > 0) {
        const versionOf = new Map(snapshots.map((s) => [s.userId, s.version]));
        await this.drizzle.db.transaction(async (txn) => {
          if (inStep.length > 0) {
            counts.projectionFindingsClosed += await this.closeFindings(
              txn,
              check.kind,
              inArray(userOf, inStep),
              'projection_caught_up',
              'the projection matched its owner after this was reported',
            );
          }
          counts.projectionDrifts += await this.fileAndAlert(
            txn,
            runId,
            fresh.map(
              (userId): ReconciliationFindingInput => ({
                runId,
                providerName: PROJECTION_FINDING_LABEL,
                kind: check.kind,
                externalId: `${userId}:${runId}`,
                detail: `the ledger projection is off the owner's version ${versionOf.get(userId)}`,
              }),
            ),
          );
        });
      }
      if (behind.length > 0) {
        await catchUp().catch((err: unknown) =>
          noteFailure(counts, `${check.kind}:catch_up`, { err, runId, players: behind.length }),
        );
      }
      let pending = conflicting;
      while (pending.length > 0 && repairsLeft > 0 && attemptsLeft > 0) {
        const attempt = pending.slice(0, Math.min(repairsLeft, attemptsLeft));
        pending = pending.slice(attempt.length);
        attemptsLeft -= attempt.length;
        let failed = attempt.length;
        try {
          const failedPlayers = await check.repair(attempt);
          failed = failedPlayers.length;
          if (failed > 0) {
            noteFailure(counts, `${check.kind}:repair`, { runId, players: failedPlayers });
          }
        } catch (err) {
          noteFailure(counts, `${check.kind}:repair`, { err, runId });
        }
        repairsLeft -= attempt.length - failed;
      }
      deferred += pending.length;
      after = snapshots.at(-1)?.userId ?? null;
    }
    if (deferred > 0) {
      counts.projectionRepairsDeferred += deferred;
      logger.warn(
        { runId, kind: check.kind, deferred },
        'reconciliation: owner re-publishes capped, the rest wait for the next cycle',
      );
    }
  }

  private async reconcileOutboxLag(
    runId: WalletJobRun['runId'],
    lagAlertMinutes: number,
    counts: { deliveryIncidents: number },
  ): Promise<void> {
    const oldest = await oldestUnrelayedEvent(this.drizzle.db);
    const lagged =
      oldest && Date.now() - oldest.occurredAt.getTime() > lagAlertMinutes * 60_000
        ? oldest
        : undefined;
    if (lagged) {
      logger.error({ runId, oldest: lagged }, 'reconciliation: the event outbox is not relaying');
    }
    counts.deliveryIncidents += await this.trackIncident(
      runId,
      'outbox_relay_lag',
      lagged && {
        externalId: `${lagged.eventId}:${runId}`,
        detail: `event ${lagged.eventId} waits to be relayed since ${lagged.occurredAt.toISOString()}`,
      },
    );
  }

  private async reconcileDeadLetters(
    runId: WalletJobRun['runId'],
    threshold: number,
    counts: { deliveryIncidents: number },
  ): Promise<void> {
    const deadLetters = await this.broker?.deadLetters?.();
    if (!deadLetters) {
      return;
    }
    const overflowing = deadLetters.count > threshold;
    if (overflowing) {
      logger.error({ runId, deadLetters }, 'reconciliation: events are dead-lettered');
    }
    counts.deliveryIncidents += await this.trackIncident(
      runId,
      'event_dead_letters',
      overflowing && {
        externalId: deadLetters.newest ?? String(deadLetters.count),
        detail: `${deadLetters.count} events dead-lettered, past the threshold of ${threshold}`,
      },
    );
  }

  private async trackIncident(
    runId: WalletJobRun['runId'],
    kind: Extract<WalletReconciliationFindingKind, 'outbox_relay_lag' | 'event_dead_letters'>,
    incident: { externalId: string; detail: string } | false | undefined,
  ): Promise<number> {
    const filed = await this.drizzle.db.transaction(async (txn) => {
      if (!incident) {
        await this.closeFindings(txn, kind, undefined, 'cleared', 'the backlog cleared');
        return 0;
      }
      const [open] = await txn
        .select({ id: walletReconciliationFinding.id })
        .from(walletReconciliationFinding)
        .where(
          and(
            eq(walletReconciliationFinding.kind, kind),
            eq(walletReconciliationFinding.status, 'open'),
          ),
        )
        .limit(1);
      if (open) {
        return 0;
      }
      return this.fileAndAlert(txn, runId, [
        { runId, providerName: EVENT_PIPELINE_FINDING_LABEL, kind, ...incident },
      ]);
    });
    if (filed > 0) {
      try {
        this.events.emit('wallet.reconciliation.alert', {
          runId,
          openFindings: await this.countOpenFindings(),
          threshold: 0,
        });
      } catch (err) {
        logger.error({ err, runId, kind }, 'reconciliation: the direct alert failed');
      }
    }
    return filed;
  }

  private async resolveMovedOnWithdrawalFindings(): Promise<number> {
    const processing = sql`${walletTransaction.status} = 'processing'`;
    const stillIn = [
      ['stuck_withdrawal_requested', sql`${walletTransaction.status} IN ('pending', 'on_hold')`],
      [
        'stuck_withdrawal_approved',
        sql`${processing} AND ${walletTransaction.providerName} IS NULL`,
      ],
      ['stuck_withdrawal_processing', processing],
    ] as const;
    let closed = 0;
    for (const [kind, stillStuck] of stillIn) {
      closed += await this.resolveFindingsLeftBehind(
        kind,
        stillStuck,
        'withdrawal_moved_on',
        'the withdrawal left this state after it was reported',
      );
    }
    return closed;
  }

  private async reconcileStuckSwaps(
    runId: WalletJobRun['runId'],
    stuckSwapAfterMinutes: number,
    batchSize: number,
    counts: { stuckSwaps: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - stuckSwapAfterMinutes * 60 * 1000);
    const alreadyReported = sql<boolean>`EXISTS (
      SELECT 1 FROM ${walletReconciliationFinding}
      WHERE ${walletReconciliationFinding.kind} = 'stuck_swap'
        AND ${walletReconciliationFinding.providerName}
            = coalesce(${walletTransaction.providerName}, ${SWAP_DESK_PROVIDER_LABEL})
        AND ${walletReconciliationFinding.externalId}
            = coalesce(${walletTransaction.providerRefId}, ${walletTransaction.id}::text)
    )`;
    const stuck = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.status, 'processing'),
          eq(walletTransaction.type, 'swap_out'),
          lt(walletTransaction.createdAt, cutoff),
        ),
      )
      .orderBy(asc(alreadyReported), asc(walletTransaction.createdAt))
      .limit(batchSize);

    for (const tx of stuck) {
      counts.stuckSwaps += 1;
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName: tx.providerName ?? SWAP_DESK_PROVIDER_LABEL,
          kind: 'stuck_swap',
          currency: tx.currency,
          amount: tx.amount,
          transactionId: tx.id,
          externalId: tx.providerRefId ?? tx.id,
          detail: `swap_out ${tx.id} has been processing since ${tx.createdAt.toISOString()}`,
        },
        this.audit,
      );
    }
  }

  private async reportStuckRequestedWithdrawals(
    runId: WalletJobRun['runId'],
    batchSize: number,
    counts: { stuckWithdrawals: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_WITHDRAWAL_REQUESTED_AFTER_MINUTES * 60_000);
    const alreadyReported = sql<boolean>`EXISTS (
      SELECT 1 FROM ${walletReconciliationFinding}
      WHERE ${walletReconciliationFinding.kind} = 'stuck_withdrawal_requested'
        AND ${walletReconciliationFinding.externalId} = ${walletTransaction.id}::text
    )`;
    const stuck = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.type, 'withdrawal'),
          inArray(walletTransaction.status, ['pending', 'on_hold']),
          lt(walletTransaction.createdAt, cutoff),
        ),
      )
      .orderBy(asc(alreadyReported), asc(walletTransaction.createdAt))
      .limit(batchSize);
    for (const tx of stuck) {
      const filed = await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName: DEFAULT_PAYMENT_PROVIDER,
          kind: 'stuck_withdrawal_requested',
          currency: tx.currency,
          network: tx.network,
          amount: tx.amount,
          transactionId: tx.id,
          externalId: tx.id,
          detail: `withdrawal requested ${tx.createdAt.toISOString()} and still undecided`,
        },
        this.audit,
      );
      if (filed) {
        counts.stuckWithdrawals += 1;
      }
    }
  }

  private async reconcileStuckSweeps(
    runId: WalletJobRun['runId'],
    unknownAfterMinutes: number,
    batchSize: number,
    counts: { stuckSweeps: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - unknownAfterMinutes * 60 * 1000);
    const alreadyReportedSweep = sql<boolean>`EXISTS (
      SELECT 1 FROM ${walletReconciliationFinding}
      WHERE ${walletReconciliationFinding.kind} = 'stuck_sweep'
        AND ${walletReconciliationFinding.providerName} = ${walletCustodySweep.providerName}
        AND ${walletReconciliationFinding.externalId}
            = coalesce(${walletCustodySweep.externalId}, ${walletCustodySweep.id}::text)
    )`;
    const stuck = await this.drizzle.db
      .select()
      .from(walletCustodySweep)
      .where(
        and(
          inArray(walletCustodySweep.status, ['pending', 'unknown']),
          lt(walletCustodySweep.createdAt, cutoff),
        ),
      )
      .orderBy(asc(alreadyReportedSweep), asc(walletCustodySweep.createdAt))
      .limit(batchSize);

    for (const sweep of stuck) {
      counts.stuckSweeps += 1;
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName: sweep.providerName,
          kind: 'stuck_sweep',
          currency: sweep.currency,
          network: sweep.network,
          amount: sweep.amount,
          txHash: sweep.txHash,
          externalId: sweep.externalId ?? sweep.id,
          detail: `custody sweep ${sweep.id} has been ${sweep.status} since ${sweep.updatedAt.toISOString()}`,
        },
        this.audit,
      );
    }
  }

  private async countOpenFindings(db: DrizzleDb | DrizzleTx = this.drizzle.db): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(walletReconciliationFinding)
      .where(
        and(
          eq(walletReconciliationFinding.status, 'open'),
          ne(walletReconciliationFinding.kind, 'below_minimum_deposit'),
        ),
      );
    return Number(row?.n ?? 0);
  }

  private async claimRun(
    runId: WalletJobRun['runId'],
    jobName: string = JOB_NAME,
    staleAfterMinutes: number = this.platformConfig?.wallet?.reconciliation?.staleRunAfterMinutes ??
      DEFAULT_STALE_RUN_AFTER_MINUTES,
  ): Promise<WalletJobRun['id'] | null> {
    const claimed = await this.retryClaim(runId, jobName);
    if (claimed) {
      return claimed;
    }

    const [existing] = await this.drizzle.db
      .select()
      .from(walletJobRun)
      .where(and(eq(walletJobRun.jobName, jobName), isNull(walletJobRun.finishedAt)));
    if (!existing) {
      return this.retryClaim(runId, jobName);
    }
    const staleAfterMs = staleAfterMinutes * 60_000;
    if (existing.startedAt.getTime() >= Date.now() - staleAfterMs) {
      return null;
    }

    const abandoned = await this.drizzle.db
      .update(walletJobRun)
      .set({ status: 'abandoned', finishedAt: new Date() })
      .where(and(eq(walletJobRun.id, existing.id), isNull(walletJobRun.finishedAt)))
      .returning({ id: walletJobRun.id });
    if (abandoned.length === 0) {
      return null;
    }
    return this.retryClaim(runId, jobName);
  }

  private async retryClaim(
    runId: WalletJobRun['runId'],
    jobName: string,
  ): Promise<WalletJobRun['id'] | null> {
    const [inserted] = await this.drizzle.db
      .insert(walletJobRun)
      .values({ jobName, runId })
      .onConflictDoNothing()
      .returning({ id: walletJobRun.id });
    return inserted?.id ?? null;
  }

  private async finishRun(
    jobRunId: WalletJobRun['id'],
    status: WalletJobRunStatus,
    summary: Record<string, unknown>,
    db: DrizzleDb | DrizzleTx = this.drizzle.db,
  ): Promise<boolean> {
    const finished = await db
      .update(walletJobRun)
      .set({ finishedAt: new Date(), status, summary })
      .where(and(eq(walletJobRun.id, jobRunId), eq(walletJobRun.status, 'running')))
      .returning({ id: walletJobRun.id });
    if (finished.length === 0) {
      logger.warn(
        { jobRunId, status },
        'wallet job run was taken over as stale before it finished; its abandoned verdict stands',
      );
    }
    return finished.length > 0;
  }
}
