import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
  createDomainError,
  createLogger,
  makeConflictError,
  makeNotFoundError,
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
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type PlatformConfig,
  type RgLimitsPort,
  type User,
  type WalletJobRunStatus,
  type WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import {
  wallet,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
  type WalletJobRun,
  type WalletReconciliationFinding as WalletReconciliationFindingRow,
  type WalletTransaction,
} from '../schema/index.js';
import type {
  ListReconciliationFindingsInput,
  ReconciliationResolution,
  WalletReconciliationFinding as WalletReconciliationFindingDto,
} from '../contract/index.js';
import { HeldDepositNotFoundError, type WalletService } from './wallet.service.js';
import {
  OUT_OF_CYCLE_RUN_ID,
  recordReconciliationFinding,
  rgDecisionForLandedCredit,
} from './reconciliation-finding.service.js';

const logger = createLogger('wallet-reconciliation');

export const ReconciliationFindingNotFoundError = makeNotFoundError('ReconciliationFinding');

export const ReconciliationCreditTransactionNotFoundError = makeNotFoundError(
  'ReconciliationCreditTransaction',
);

export const ReconciliationCreditMismatchError = makeConflictError(
  'ReconciliationCreditMismatchError',
  "The referenced transaction is not a manual credit matching this finding's currency and amount",
);

export const ReconciliationRefundAmountError = createDomainError<
  [refunded: string, deposited: string | null]
>(
  'ReconciliationRefundAmountError',
  (refunded, deposited) =>
    `A refund of ${refunded} exceeds the ${deposited ?? 'unknown'} this finding is about`,
);

export const ReconciliationAttributionError = createDomainError<[reason: string]>(
  'ReconciliationAttributionError',
  (reason) => `The deposit cannot be credited to this player: ${reason}`,
);

export const ReconciliationOutcomeNotAllowedError = createDomainError<
  [kind: string, outcome: string]
>(
  'ReconciliationOutcomeNotAllowedError',
  (kind, outcome) => `A ${kind} finding cannot be resolved as ${outcome}`,
);

/** Findings about on-chain money that reached custody for a player (or should have). */
const DEPOSIT_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'missing_deposit',
  'unattributed_deposit',
  'amount_mismatch',
  'currency_mismatch',
  'held_deposit',
]);

/**
 * Deposits whose money is in custody and on no player's balance, so sending it back on chain
 * settles them. An amount or currency mismatch is a deposit the player was already credited
 * for: refunding it would pay the same money twice.
 */
const REFUNDABLE_FINDING_KINDS: ReadonlySet<WalletReconciliationFindingKind> = new Set([
  'held_deposit',
  'missing_deposit',
  'unattributed_deposit',
]);

function assertOutcomeAllowed(
  kind: WalletReconciliationFindingKind,
  outcome: ReconciliationResolution['outcome'],
): void {
  const allowed =
    kind === 'held_deposit'
      ? outcome === 'released' || outcome === 'refunded'
      : outcome === 'credited' ||
        outcome === 'dismissed' ||
        (outcome === 'refunded' && REFUNDABLE_FINDING_KINDS.has(kind));
  if (!allowed) {
    throw new ReconciliationOutcomeNotAllowedError(kind, outcome);
  }
}

// Lowercased: an EVM address is the same account whatever its checksum casing.
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type LedgerMatch = Pick<WalletTransaction, 'id' | 'currency' | 'amount' | 'network'>;

/**
 * Pure diff of one vendor deposit event against its (maybe absent) ledger row - the
 * whole decision reconciliation makes for a deposit, extracted so it is unit-testable
 * without a database. Never routes through moneyToNumber (see money.md): an exact
 * decimal compare, not a float one.
 */
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

// Vendor listTransactions batches are thousands of rows; a well-under-the-parameter-
// ceiling chunk size keeps every lookup a single inArray(...) round trip per chunk,
// never one query per vendor transaction.
const PROVIDER_REF_LOOKUP_CHUNK_SIZE = 1000;

// A claimed run stuck this long is presumed crashed (the process died mid-cycle) rather
// than still working, so the next tick may mark it `abandoned` and take the slot over.
// Distinct from the vendor-side ambiguity thresholds: this one is about our own worker.
const DEFAULT_STALE_RUN_AFTER_MINUTES = 30;

/** Fallback when reconciliation runs without a `wallet.sweep` config block. */
const DEFAULT_UNKNOWN_AFTER_MINUTES = 60;

// A swap leg carries no payment provider name, but a finding needs one to be filed under.
const SWAP_DESK_PROVIDER_LABEL = 'swap-desk';

const JOB_NAME = 'wallet-reconciliation';

/**
 * Ceiling on catching up after an outage, as a multiple of `lookbackHours`. Recovering
 * from a week of downtime must not ask a vendor for one unbounded page of history.
 */
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

export type ReconciliationServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  wallet: WalletService;
  paymentProviders: PaymentProviderRegistry;
  audit: AuditWritePort;
  platformConfig?: PlatformConfig;
  rgLimits?: RgLimitsPort;
};

/**
 * Owns the reconciliation job cycle (claim -> per-provider diff -> stuck-withdrawal /
 * stuck-sweep sweep -> finish + audit + alert) and the admin surface over its findings
 * (list/resolve). A finding is a report; the cycle never credits anything itself. Money
 * moves only through `WalletService`: `reconcileWithdrawalStatus` (already idempotent) in
 * the cycle, and in a resolution the deposit credit or release (after the deposit hold
 * policy) or the manual-adjustment row a non-deposit `credited` resolution references.
 */
export class ReconciliationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly wallet: WalletService;
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;
  private readonly rgLimits?: RgLimitsPort;

  constructor({
    drizzle,
    events,
    wallet,
    paymentProviders,
    audit,
    platformConfig,
    rgLimits,
  }: ReconciliationServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.wallet = wallet;
    this.paymentProviders = paymentProviders;
    this.audit = audit;
    this.platformConfig = platformConfig;
    this.rgLimits = rgLimits;
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

  /**
   * The finding row is locked first, so a second resolve of an already-resolved finding
   * returns it unchanged, with no second audit entry and no second money move.
   *
   * `credited` on an on-chain deposit finding credits the deposit here, in this transaction,
   * after the deposit hold policy: a player it would hold gets nothing and the finding stays
   * open. Any other finding's `credited` references a `manual_credit` already made, matching
   * its currency and amount exactly. A held deposit closes only by `released` (credited here,
   * after the same policy check) or `refunded`; it is never dismissed, because the money is
   * still in custody. A refund names the on-chain transaction, its destination and amount,
   * and is open only to deposits no player was credited for.
   */
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

      let transactionId: string | undefined;
      let resolutionNote: string | null = null;
      let heldWithdrawalId: string | null = null;
      let refundedDepositId: string | null = null;
      let creditedDeposit: CreditedDeposit | undefined;
      let releasedDeposit: CreditedDeposit | undefined;

      if (resolution.outcome === 'credited') {
        if (DEPOSIT_FINDING_KINDS.has(finding.kind)) {
          if (resolution.transactionId) {
            throw new ReconciliationOutcomeNotAllowedError(finding.kind, 'a manual credit');
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
              'credited without a manual credit',
            );
          }
          const [tx] = await txn
            .select()
            .from(walletTransaction)
            .where(eq(walletTransaction.id, resolution.transactionId));
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
          transactionId = tx.id;
          // Crediting a player for a withdrawal whose vendor outcome is unknown settles it by
          // hand. The held row must leave `processing` with it, or the next reconciliation
          // run (or a late webhook) can still refund or complete it on top of the credit.
          if (finding.kind === 'unknown_at_provider') {
            heldWithdrawalId = finding.transactionId;
          }
        }
      } else if (resolution.outcome === 'released') {
        if (!finding.transactionId) {
          throw new HeldDepositNotFoundError();
        }
        const deposit = await this.wallet.releaseHeldDeposit(txn, finding.transactionId, adminId);
        releasedDeposit = { ...deposit, transactionId: finding.transactionId };
      } else if (resolution.outcome === 'refunded') {
        if (finding.amount === null || moneyCompare(resolution.amount, finding.amount) > 0) {
          throw new ReconciliationRefundAmountError(resolution.amount, finding.amount);
        }
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
        } else if (finding.kind === 'missing_deposit') {
          refundedDepositId = await this.recordMissingDepositRefunded(txn, finding, adminId);
        }
      } else {
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

      if (heldWithdrawalId) {
        await txn
          .update(walletTransaction)
          .set({ status: 'failed' })
          .where(
            and(
              eq(walletTransaction.id, heldWithdrawalId),
              eq(walletTransaction.type, 'withdrawal'),
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
        before: { status: 'open', transactionId: finding.transactionId },
        after: {
          status: row.status,
          outcome: resolution.outcome,
          transactionId: row.transactionId,
          resolutionNote: row.resolutionNote,
          closedWithdrawalId: heldWithdrawalId,
          releasedDepositId: releasedDeposit?.transactionId ?? null,
          creditedDeposit: creditedDeposit ?? null,
          refundedDepositId,
          ...(resolution.outcome === 'refunded'
            ? {
                refundAmount: resolution.amount,
                refundCurrency: finding.currency,
                refundTxHash: resolution.txHash,
                refundDestinationAddress: resolution.destinationAddress,
                // null when the vendor never reported who sent the deposit.
                refundDestinationDiffersFromSource:
                  finding.sourceAddress === null
                    ? null
                    : !sameAddress(finding.sourceAddress, resolution.destinationAddress),
              }
            : {}),
        },
        ...meta,
      });
      return {
        dto: toFindingDto(row),
        credited: creditedDeposit
          ? { finding: row, deposit: creditedDeposit }
          : releasedDeposit
            ? { finding: undefined, deposit: releasedDeposit }
            : undefined,
      };
    });

    if (credited) {
      await this.wallet.announceDepositCompleted(credited.deposit);
      if (credited.finding) {
        await this.recordRgBreachForHandCredit(credited.finding, credited.deposit);
      }
    }
    return dto;
  }

  /**
   * Who an on-chain deposit finding belongs to and how much of it the player is still owed.
   * A finding whose deposit no ledger row carries yet is owed in full and is keyed on the
   * vendor id, so a webhook redelivery replays it. One whose ledger row exists is owed only
   * the shortfall of an underpaid amount; any other (a currency mismatch, an overpayment, a
   * deposit still held) is not a credit at all.
   */
  private async creditDepositFinding(
    txn: DrizzleTx,
    finding: WalletReconciliationFindingRow,
    adminId: User['id'],
    attributedUserId: User['id'] | undefined,
  ): Promise<CreditedDeposit> {
    if (finding.currency === null || finding.amount === null) {
      throw new ReconciliationCreditMismatchError();
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
          'credited while its ledger deposit is not a completed one in the same currency',
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

  /**
   * A missing deposit refunded on chain becomes a terminal `refunded` deposit row keyed on
   * the vendor id, or the vendor redelivering it would still credit the player. A deposit to
   * an address no player owns has no wallet to key it on, and a redelivery of it is filed
   * as unattributed, never credited, so it records nothing.
   */
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

  /**
   * A report on top of the policy `creditDepositFinding` already asked: with no policy bound
   * nothing refuses a deposit past the player's limit, so the breach becomes a finding, as
   * on the webhook path. The credit is a committed `deposit` row the gate already reads out
   * of the window, so the attempted move is `0`.
   *
   * Never blocks the resolution: the admin's credit has already committed, and failing
   * their request over a report would only lose the report - a retry finds the finding
   * resolved and returns early. A write that fails is logged and lost; the audit row for
   * the resolution still names the admin, the amount and the transaction.
   */
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
          // The resolved finding's own id, not its externalId: the vendor id already keys
          // a breach filed for the same deposit by the webhook path, and these two are
          // separate credits of separate money whenever both exist.
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

  /**
   * The window is anchored to the last completed run, not to the wall clock. BullMQ
   * repeatable jobs are delayed jobs: a tick missed while no worker was running is
   * skipped, never backfilled. Against a fixed `now - lookbackHours` window that means
   * any outage longer than `lookbackHours` leaves a span nothing ever reconciles and
   * nothing ever reports - the worst possible failure mode for a compensating control.
   * Catching up is capped, and a capped window is reported rather than passed over.
   */
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

  /**
   * Claim -> per-provider deposit/withdrawal diff -> stuck-withdrawal / stuck-sweep
   * sweep -> finish + one audit entry + an alert past threshold. Returns null without
   * doing any work when another cycle already owns the claim - the caller (cron tick or
   * the on-demand route's worker) treats that as a normal, expected outcome.
   */
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
      swapFindingsClosed: 0,
      unreconciledHours: 0,
    };

    try {
      const cfg = this.platformConfig?.wallet?.reconciliation;
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

        for (const providerName of this.paymentProviders.names()) {
          await this.reconcileProvider(runId, providerName, since, until, counts);
        }

        await this.reconcileStuckWithdrawals(runId, cfg.stuckAfterMinutes, cfg.batchSize, counts);

        // Close first, then file: a leg the desk settled after it was reported stops
        // describing a situation that no longer exists before this cycle adds more.
        await this.resolveSettledSwapFindings(counts);
        await this.reconcileStuckSwaps(
          runId,
          cfg.stuckSwapAfterMinutes ?? cfg.stuckAfterMinutes,
          cfg.batchSize,
          counts,
        );

        // Deliberately not gated on `wallet.sweep` being configured. An operator can
        // adopt reconciliation without sweeping, and a stuck sweep is real player money
        // parked vendor-side in an ambiguous state - the last finding class that should
        // quietly switch itself off because a different feature's config block is absent.
        await this.reconcileStuckSweeps(
          runId,
          this.platformConfig?.wallet?.sweep?.unknownAfterMinutes ?? DEFAULT_UNKNOWN_AFTER_MINUTES,
          cfg.batchSize,
          counts,
        );
      }

      const openFindings = await this.countOpenFindings();
      const status = cfg ? 'completed' : 'skipped';
      await this.finishRun(jobRunId, status, { ...counts, openFindings });
      await this.audit.record({
        actorType: 'system',
        action: cfg ? 'wallet.reconciliation_run.completed' : 'wallet.reconciliation_run.skipped',
        resourceType: 'wallet_job_run',
        resourceId: runId,
        after: { runId, ...counts, openFindings },
      });

      if (cfg && openFindings > cfg.alertThreshold) {
        logger.error(
          { runId, openFindings, threshold: cfg.alertThreshold },
          'wallet reconciliation: open findings exceed threshold',
        );
        this.events.emit('wallet.reconciliation.alert', {
          runId,
          openFindings,
          threshold: cfg.alertThreshold,
        });
      }

      return { runId };
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
      throw err;
    }
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

    // Every sweep (an internal transfer of vendor-side funds, never a ledger row) shows
    // up in the vendor's own transaction list too - exclude it BEFORE diffing, or every
    // sweep files a false missing_deposit/unmatched-withdrawal finding.
    const swept = await this.sweptExternalIds(providerName, since);
    const relevant = events.filter((event) => !swept.has(event.externalId));

    const deposits = relevant.filter(
      (event): event is Extract<PaymentWebhookEvent, { kind: 'deposit' }> =>
        event.kind === 'deposit',
    );
    const withdrawals = relevant.filter(
      (event): event is Extract<PaymentWebhookEvent, { kind: 'withdrawal' }> =>
        event.kind === 'withdrawal',
    );

    await this.reconcileDeposits(runId, providerName, deposits, counts);

    for (const event of withdrawals) {
      // Reconciliation is the same normalization a webhook produces, polled instead of
      // pushed - already idempotent, already guards on status === 'processing'.
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

  private async reconcileDeposits(
    runId: WalletJobRun['runId'],
    providerName: string,
    deposits: readonly Extract<PaymentWebhookEvent, { kind: 'deposit' }>[],
    counts: { missingDeposit: number; currencyMismatch: number; amountMismatch: number },
  ): Promise<void> {
    if (deposits.length === 0) {
      return;
    }
    const byExternalId = await this.batchLookupByProviderRefId(
      providerName,
      deposits.map((d) => d.externalId),
    );

    for (const event of deposits) {
      const tx = byExternalId.get(event.externalId);
      const result = diffDeposit(event, tx);
      if (result === null) {
        continue;
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

  // Single chunked inArray(...) batch read (chunks well under the parameter ceiling) -
  // never one query per vendor transaction over a window that is routinely thousands of rows.
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

  // wallet_transaction_status_type_created_at_idx covers the WHERE - equality on status
  // and type, then a range on createdAt, in that column order. The ORDER BY's leading
  // correlated EXISTS is not indexable, so the matching set is sorted before LIMIT.
  private async reconcileStuckWithdrawals(
    runId: WalletJobRun['runId'],
    stuckAfterMinutes: number,
    batchSize: number,
    counts: { unknownAtProvider: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000);
    // Mirrors the externalId this loop files below, which is the findings dedup key.
    const alreadyReported = sql<boolean>`EXISTS (
      SELECT 1 FROM ${walletReconciliationFinding}
      WHERE ${walletReconciliationFinding.kind} = 'unknown_at_provider'
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
          // From approval, not request: a row that sat in the manual queue is not stuck the
          // moment an admin approves it, while its vendor call may still be in flight.
          lt(
            sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`,
            cutoff,
          ),
        ),
      )
      // Unreported first, then oldest. Findings dedupe on (kind, providerName, externalId), so a row
      // already reported produces nothing on a re-run: ordering it last stops a
      // permanent backlog from filling the batch and hiding newer stuck withdrawals,
      // while still re-checking it at the vendor whenever the batch has room.
      .orderBy(asc(alreadyReported), asc(walletTransaction.createdAt))
      .limit(batchSize);

    for (const tx of stuck) {
      // One unreachable vendor or bad row must not abort the run - stuck swaps and sweeps
      // are checked after this loop, and a row that throws would sort first forever.
      try {
        await this.reconcileStuckWithdrawal(runId, tx, counts);
      } catch (err) {
        logger.error(
          { err, transactionId: tx.id },
          'reconciliation: stuck withdrawal check failed',
        );
      }
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
      // Never an automatic refund: "no record yet" does not prove the payout never left.
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

  /**
   * Closes `stuck_swap` findings the desk settled after they were reported - a
   * report-side write only, matching what this table is for: it never touches a balance,
   * a transaction status, or the swap itself. Without it a slow-but-healthy swap leaves
   * an `open` finding describing a situation that no longer exists, and since
   * `countOpenFindings` feeds `alertThreshold`, a growing pile of them alerts on nothing.
   */
  private async resolveSettledSwapFindings(counts: { swapFindingsClosed: number }): Promise<void> {
    const settled = sql`EXISTS (
      SELECT 1 FROM ${walletTransaction}
      WHERE ${walletTransaction.id} = ${walletReconciliationFinding.transactionId}
        AND ${walletTransaction.status} <> 'processing'
    )`;
    const closed = await this.drizzle.db
      .update(walletReconciliationFinding)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNote: 'the desk settled this swap after it was reported',
      })
      .where(
        and(
          eq(walletReconciliationFinding.kind, 'stuck_swap'),
          eq(walletReconciliationFinding.status, 'open'),
          settled,
        ),
      )
      .returning({ id: walletReconciliationFinding.id });

    // `resolvedBy` stays null: no admin acted, and the audit entry's system actor is
    // what says who did. A finding closed here never carries a `credited` outcome,
    // because nothing on this path moves money.
    for (const row of closed) {
      counts.swapFindingsClosed += 1;
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.reconciliation_finding.resolved',
        resourceType: 'wallet_reconciliation_finding',
        resourceId: row.id,
        before: { status: 'open' },
        after: { status: 'resolved', outcome: 'settled_at_desk' },
      });
    }
  }

  // Human resolution only, like a stuck sweep. A swap_out held `processing` past the cutoff
  // is money debited from the player with nothing credited back, and the desk may or may not
  // have filled it - so neither a refund nor a credit is safe without someone looking.
  //
  // wallet_transaction_status_type_created_at_idx covers the WHERE, but the ORDER BY leads
  // with the correlated EXISTS, which no index serves: every cycle sorts the whole matching
  // set before LIMIT. That set is bounded in practice only because resolveSettledSwapFindings
  // closes findings - not because the plan is cheap. Same shape as the sweep sibling.
  private async reconcileStuckSwaps(
    runId: WalletJobRun['runId'],
    stuckSwapAfterMinutes: number,
    batchSize: number,
    counts: { stuckSwaps: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - stuckSwapAfterMinutes * 60 * 1000);
    // Mirrors the externalId this loop files below, which is the findings dedup key.
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
          // The desk's own reference when there is one, as every other kind in this table
          // does, so an operator can join findings to desk records. A leg that died before
          // `execute` returned has none, and falls back to the local id - the same
          // `providerRefId ?? id` shape the sweep sibling files.
          externalId: tx.providerRefId ?? tx.id,
          detail: `swap_out ${tx.id} has been processing since ${tx.createdAt.toISOString()}`,
        },
        this.audit,
      );
    }
  }

  // wallet_custody_sweep_status_created_at_idx covers the WHERE; the ORDER BY's leading
  // correlated EXISTS is not indexable, as in the two siblings above. Human resolution
  // only - this NEVER touches the sweep row's status or releases its in-flight guard.
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
          // `pending` belongs here alongside `unknown`. A worker that dies between the
          // claim insert and the vendor call leaves a `pending` row with no externalId:
          // resolveInFlightSweeps skips it (nothing to poll) and the partial unique
          // index still counts it as in-flight, so that container would never sweep
          // again and nothing would say why. Same lost-response ambiguity as `unknown`,
          // so it files a finding for a human rather than releasing the guard.
          inArray(walletCustodySweep.status, ['pending', 'unknown']),
          lt(walletCustodySweep.createdAt, cutoff),
        ),
      )
      // Same starvation guard as reconcileStuckWithdrawals: already-reported sweeps go
      // last so a permanent backlog cannot hide newer stuck ones from the operator.
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

  private async countOpenFindings(): Promise<number> {
    const [row] = await this.drizzle.db
      .select({ n: count() })
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.status, 'open'));
    return Number(row?.n ?? 0);
  }

  /**
   * The claim IS the insert - a partial unique index on (jobName) WHERE finishedAt IS
   * NULL makes a conflicting insert the concurrency guard. A stale in-flight run (older
   * than the configured staleness window - presumed crashed) is marked `abandoned` and its slot freed
   * for this call to retry the claim once.
   */
  private async claimRun(runId: WalletJobRun['runId']): Promise<WalletJobRun['id'] | null> {
    const claimed = await this.retryClaim(runId);
    if (claimed) {
      return claimed;
    }

    const [existing] = await this.drizzle.db
      .select()
      .from(walletJobRun)
      .where(and(eq(walletJobRun.jobName, JOB_NAME), isNull(walletJobRun.finishedAt)));
    if (!existing) {
      // The blocking run finished between our insert conflict and this read - retry once.
      return this.retryClaim(runId);
    }
    const staleAfterMs =
      (this.platformConfig?.wallet?.reconciliation?.staleRunAfterMinutes ??
        DEFAULT_STALE_RUN_AFTER_MINUTES) * 60_000;
    if (existing.startedAt.getTime() >= Date.now() - staleAfterMs) {
      // A live run genuinely owns the claim - return immediately, no retry loop.
      return null;
    }

    const abandoned = await this.drizzle.db
      .update(walletJobRun)
      .set({ status: 'abandoned', finishedAt: new Date() })
      .where(and(eq(walletJobRun.id, existing.id), isNull(walletJobRun.finishedAt)))
      .returning({ id: walletJobRun.id });
    if (abandoned.length === 0) {
      // Someone else already resolved the stale run concurrently.
      return null;
    }
    return this.retryClaim(runId);
  }

  private async retryClaim(runId: WalletJobRun['runId']): Promise<WalletJobRun['id'] | null> {
    const [inserted] = await this.drizzle.db
      .insert(walletJobRun)
      .values({ jobName: JOB_NAME, runId })
      .onConflictDoNothing()
      .returning({ id: walletJobRun.id });
    return inserted?.id ?? null;
  }

  // Keyed on the claimed row's own id, never on runId: a job retried by the queue
  // carries the same runId as the attempt that failed, so `WHERE run_id = ...` would
  // reach back and rewrite that earlier row's `failed`/`abandoned` verdict to
  // `completed` - erasing the only evidence that the first attempt went wrong.
  private async finishRun(
    jobRunId: WalletJobRun['id'],
    status: WalletJobRunStatus,
    summary: Record<string, unknown>,
  ): Promise<void> {
    await this.drizzle.db
      .update(walletJobRun)
      .set({ finishedAt: new Date(), status, summary })
      .where(eq(walletJobRun.id, jobRunId));
  }
}
