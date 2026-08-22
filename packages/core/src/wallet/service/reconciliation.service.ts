import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import {
  type DrizzleService,
  type EventBus,
  createLogger,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  moneyEquals,
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
  type User,
  type WalletJobRunStatus,
} from '@openora/core/contracts';
import {
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
import type { WalletService } from './wallet.service.js';
import { recordReconciliationFinding } from './reconciliation-finding.service.js';

const logger = createLogger('wallet-reconciliation');

export const ReconciliationFindingNotFoundError = makeNotFoundError('ReconciliationFinding');

export const ReconciliationCreditTransactionNotFoundError = makeNotFoundError(
  'ReconciliationCreditTransaction',
);

export const ReconciliationCreditMismatchError = makeConflictError(
  'ReconciliationCreditMismatchError',
  "The referenced transaction is not a manual credit matching this finding's currency and amount",
);

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

const JOB_NAME = 'wallet-reconciliation';

/**
 * Ceiling on catching up after an outage, as a multiple of `lookbackHours`. Recovering
 * from a week of downtime must not ask a vendor for one unbounded page of history.
 */
const MAX_CATCH_UP_MULTIPLE = 7;

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
};

/**
 * Owns the reconciliation job cycle (claim -> per-provider diff -> stuck-withdrawal /
 * stuck-sweep sweep -> finish + audit + alert) and the admin surface over its findings
 * (list/resolve). Never credits or moves money itself - every finding is a report; the
 * only paths that touch a balance are `WalletService.reconcileWithdrawalStatus` (already
 * idempotent) and the pre-existing manual-adjustment path a `credited` resolution merely
 * references.
 */
export class ReconciliationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly wallet: WalletService;
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;

  constructor({
    drizzle,
    events,
    wallet,
    paymentProviders,
    audit,
    platformConfig,
  }: ReconciliationServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.wallet = wallet;
    this.paymentProviders = paymentProviders;
    this.audit = audit;
    this.platformConfig = platformConfig;
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
   * Conditional `UPDATE ... WHERE status = 'open'` is the whole double-resolve guard -
   * a second resolve of an already-resolved finding matches zero rows and returns the
   * row unchanged, with no second audit entry. `credited` requires the referenced
   * transaction to already exist (the manual-adjustment path creates it - this never
   * credits anything itself) and match the finding's currency/amount exactly.
   */
  async resolveFinding(
    adminId: User['id'],
    id: WalletReconciliationFindingRow['id'],
    resolution: ReconciliationResolution,
    meta?: ClientMeta,
  ): Promise<WalletReconciliationFindingDto> {
    return this.drizzle.db.transaction(async (txn) => {
      let transactionId: string | undefined;
      let resolutionNote: string | null = null;

      if (resolution.outcome === 'credited') {
        const [finding] = await txn
          .select()
          .from(walletReconciliationFinding)
          .where(eq(walletReconciliationFinding.id, id));
        if (!finding) {
          throw new ReconciliationFindingNotFoundError(id);
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
      } else {
        resolutionNote = resolution.note;
      }

      const updated = await txn
        .update(walletReconciliationFinding)
        .set({
          status: 'resolved',
          resolvedBy: adminId,
          resolvedAt: new Date(),
          resolutionNote,
          ...(transactionId ? { transactionId } : {}),
        })
        .where(
          and(
            eq(walletReconciliationFinding.id, id),
            eq(walletReconciliationFinding.status, 'open'),
          ),
        )
        .returning();

      if (updated.length === 0) {
        const [existing] = await txn
          .select()
          .from(walletReconciliationFinding)
          .where(eq(walletReconciliationFinding.id, id));
        // Already resolved by a concurrent/earlier call: return it unchanged, no audit entry.
        return toFindingDto(
          findOneOrThrow(existing ? [existing] : [], new ReconciliationFindingNotFoundError(id)),
        );
      }

      const row = findOneOrThrow(updated, new ReconciliationFindingNotFoundError(id));
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.reconciliation_finding.resolved',
        resourceType: 'wallet_reconciliation_finding',
        resourceId: row.id,
        before: { status: 'open' },
        after: {
          status: row.status,
          outcome: resolution.outcome,
          transactionId: row.transactionId,
          resolutionNote: row.resolutionNote,
        },
        ...meta,
      });
      return toFindingDto(row);
    });
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

        await this.reconcileStuckWithdrawals(runId, cfg.stuckAfterMinutes, counts);

        // Deliberately not gated on `wallet.sweep` being configured. An operator can
        // adopt reconciliation without sweeping, and a stuck sweep is real player money
        // parked vendor-side in an ambiguous state - the last finding class that should
        // quietly switch itself off because a different feature's config block is absent.
        await this.reconcileStuckSweeps(
          runId,
          this.platformConfig?.wallet?.sweep?.unknownAfterMinutes ?? DEFAULT_UNKNOWN_AFTER_MINUTES,
          counts,
        );
      }

      const openFindings = await this.countOpenFindings();
      await this.finishRun(jobRunId, 'completed', { ...counts, openFindings });
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.reconciliation_run.completed',
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
      await this.wallet.reconcileWithdrawalStatus(event);
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
    const byExternalId = await this.batchLookupByProviderRefId(deposits.map((d) => d.externalId));

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
      await recordReconciliationFinding(this.drizzle.db, {
        runId,
        providerName,
        kind: result,
        currency: event.currency,
        network: event.network ?? tx?.network ?? null,
        amount: event.amount,
        address: event.address,
        tag: event.tag ?? null,
        txHash: event.txHash,
        externalId: event.externalId,
        transactionId: tx?.id ?? null,
        detail:
          result === 'currency_mismatch'
            ? `ledger currency ${tx?.currency}, vendor reported ${event.currency}`
            : result === 'amount_mismatch'
              ? `ledger amount ${tx?.amount}, vendor reported ${event.amount}`
              : null,
      });
    }
  }

  // Single chunked inArray(...) batch read (chunks well under the parameter ceiling) -
  // never one query per vendor transaction over a window that is routinely thousands of rows.
  private async batchLookupByProviderRefId(
    externalIds: string[],
  ): Promise<Map<string, WalletTransaction>> {
    const byExternalId = new Map<string, WalletTransaction>();
    for (const batch of chunk(externalIds, PROVIDER_REF_LOOKUP_CHUNK_SIZE)) {
      const rows = await this.drizzle.db
        .select()
        .from(walletTransaction)
        .where(inArray(walletTransaction.providerRefId, batch));
      for (const row of rows) {
        if (row.providerRefId) {
          byExternalId.set(row.providerRefId, row);
        }
      }
    }
    return byExternalId;
  }

  // Covered exactly by wallet_transaction_status_type_created_at_idx - equality on
  // status and type, then a range on createdAt, in that column order.
  private async reconcileStuckWithdrawals(
    runId: WalletJobRun['runId'],
    stuckAfterMinutes: number,
    counts: { unknownAtProvider: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000);
    const stuck = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.status, 'processing'),
          eq(walletTransaction.type, 'withdrawal'),
          lt(walletTransaction.createdAt, cutoff),
        ),
      );

    for (const tx of stuck) {
      const providerName = tx.providerName ?? DEFAULT_PAYMENT_PROVIDER;
      const provider = this.paymentProviders.get(providerName);

      // Nothing to look up at all (crashed before the vendor ever responded with a
      // reference) - still worth a finding, deduped on the transaction's own id.
      if (!tx.providerRefId) {
        counts.unknownAtProvider += 1;
        await recordReconciliationFinding(this.drizzle.db, {
          runId,
          providerName,
          kind: 'unknown_at_provider',
          currency: tx.currency,
          network: tx.network,
          amount: tx.amount,
          transactionId: tx.id,
          externalId: tx.id,
          detail: 'withdrawal has no providerRefId to look up at the vendor',
        });
        continue;
      }

      const status = await provider?.adapter.getWithdrawalStatus?.(tx.providerRefId);
      if (status) {
        await this.wallet.reconcileWithdrawalStatus({
          kind: 'withdrawal',
          externalId: tx.providerRefId,
          status: status.status,
          ...(status.txHash ? { txHash: status.txHash } : {}),
        });
        continue;
      }

      counts.unknownAtProvider += 1;
      await recordReconciliationFinding(this.drizzle.db, {
        runId,
        providerName,
        kind: 'unknown_at_provider',
        currency: tx.currency,
        network: tx.network,
        amount: tx.amount,
        transactionId: tx.id,
        externalId: tx.providerRefId,
        detail: 'vendor has no record of this withdrawal',
      });
    }
  }

  // Covered exactly by wallet_custody_sweep_status_created_at_idx. Human resolution
  // only - this NEVER touches the sweep row's status or releases its in-flight guard.
  private async reconcileStuckSweeps(
    runId: WalletJobRun['runId'],
    unknownAfterMinutes: number,
    counts: { stuckSweeps: number },
  ): Promise<void> {
    const cutoff = new Date(Date.now() - unknownAfterMinutes * 60 * 1000);
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
      );

    for (const sweep of stuck) {
      counts.stuckSweeps += 1;
      await recordReconciliationFinding(this.drizzle.db, {
        runId,
        providerName: sweep.providerName,
        kind: 'stuck_sweep',
        currency: sweep.currency,
        network: sweep.network,
        amount: sweep.amount,
        txHash: sweep.txHash,
        externalId: sweep.externalId ?? sweep.id,
        detail: `custody sweep ${sweep.id} has been ${sweep.status} since ${sweep.updatedAt.toISOString()}`,
      });
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
