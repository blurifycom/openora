import {
  DrizzleService,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  mapConcurrent,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import {
  normalizeKycStatus,
  type KycAdapter,
  type KycCheckResult,
  type KycDocument,
  type KycRiskSignals,
  type KycStatusWriter,
  type KycVendorStatus,
  type KycStatus,
  type PlatformConfig,
  type User,
  ClientMeta,
} from '@openora/core/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { kycVerification, type KycVerification } from '../schema/index.js';
// Cross-domain reads via public /schema subpaths (ADR-0020); the wallet ledger is the
// source of truth for lifetime deposits (player.totalDeposits is not maintained).
import { player } from '@openora/core/pam/schema/profile';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import type {
  SubmitKycInput,
  PlayerKycView,
  KycOverrideStatus,
  BulkApproveKycResult,
} from '../contract/index.js';
import { CumulativeDepositReKycTrigger, type ReKycTrigger } from './re-kyc-trigger.js';

const logger = createLogger('compliance-kyc');

type DrizzleTx =
  | DrizzleService['db']
  | Parameters<Parameters<DrizzleService['db']['transaction']>[0]>[0];

const DEFAULT_PROVIDER = 'mock';
const MANUAL_PROVIDER = 'manual';
const BULK_APPROVE_CONCURRENCY = 10;

export const PlayerNotFoundError = makeNotFoundError('Player');

export const KycVerificationNotFoundError = makeNotFoundError('KycVerification');

function mapVendorStatus(vendor: KycVendorStatus) {
  switch (vendor) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'pending':
      return 'pending';
    case 'not_started':
      return 'not_started';
  }
}

function isDecided(status: KycStatus) {
  const normalized = normalizeKycStatus(status);
  return (
    normalized === 'approved' || normalized === 'rejected' || normalized === 'manually_overridden'
  );
}

function resolveManualStatus(status: KycOverrideStatus): KycStatus {
  return status === 'approved' ? 'manually_overridden' : status;
}

const HIGH_RISK_SIGNAL_KEYS = [
  'duplicateDeviceDetected',
  'highRiskCountryDetected',
] as const satisfies ReadonlyArray<keyof KycRiskSignals>;

function warrantsHighRiskTag(signals: KycRiskSignals): boolean {
  return HIGH_RISK_SIGNAL_KEYS.some((key) => signals[key]);
}

const NO_STEPS_RESOLVED_CHECK: KycCheckResult = { step: 'workflow', status: 'unknown' };

function findIncompleteCheck(checks?: KycCheckResult[]): KycCheckResult | undefined {
  if (checks === undefined) {
    return undefined;
  }
  if (checks.length === 0) {
    return NO_STEPS_RESOLVED_CHECK;
  }
  return checks.find((check) => check.status !== 'approved');
}

function describeIncompleteCheck(check: KycCheckResult): string {
  return `Vendor reported approved but "${check.step}" has not reached a successful state (status: ${check.status})`;
}

function toDto(row: KycVerification) {
  return serializeRow(row, {
    dateFields: ['submittedAt', 'decidedAt', 'createdAt', 'updatedAt'],
  });
}

/**
 * Owns the append-only `kyc_verification` history and the submit/reconcile/re-KYC
 * lifecycle. All `player.kycStatus` writes go through the injected KycStatusWriter
 * (pam-owned single-writer seam); this service never touches the player table for writes.
 */
export type KycVerificationDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  kycAdapter: KycAdapter;
  statusWriter: KycStatusWriter;
  platformConfig?: PlatformConfig;
  reKycTrigger?: ReKycTrigger;
};

export class KycVerificationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly kycAdapter: KycAdapter;
  private readonly statusWriter: KycStatusWriter;
  private readonly platformConfig?: PlatformConfig;
  private readonly reKycTrigger: ReKycTrigger;

  constructor(deps: KycVerificationDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.kycAdapter = deps.kycAdapter;
    this.statusWriter = deps.statusWriter;
    this.platformConfig = deps.platformConfig;
    this.reKycTrigger = deps.reKycTrigger ?? new CumulativeDepositReKycTrigger();
  }

  private get provider() {
    return this.platformConfig?.kyc?.provider ?? DEFAULT_PROVIDER;
  }

  async submit(userId: User['id'], input: SubmitKycInput, meta?: ClientMeta) {
    const result = await this.kycAdapter.submit(
      userId,
      input.documents.map((d) => ({ type: d.type, frontUrl: d.frontUrl, backUrl: d.backUrl })),
    );
    const mappedStatus = mapVendorStatus(result.status);
    const incompleteCheck =
      mappedStatus === 'approved' ? findIncompleteCheck(result.checks) : undefined;
    const status = incompleteCheck ? 'resubmission_requested' : mappedStatus;
    const decisionReason = incompleteCheck ? describeIncompleteCheck(incompleteCheck) : null;
    const decided = isDecided(status);

    const row = await this.drizzle.db.transaction(async (trx) => {
      const inserted = findOneOrThrow(
        await trx
          .insert(kycVerification)
          .values({
            userId,
            provider: this.provider,
            referenceId: result.referenceId,
            status,
            documentTypes: input.documents.map((d) => d.type),
            decisionReason,
            checks: result.checks ?? null,
            triggeredBy: 'submission',
            decidedAt: decided ? new Date() : null,
            decisionReceivedAt: new Date(),
          })
          .returning(),
        new KycVerificationNotFoundError(userId),
      );
      await this.statusWriter.setStatus(userId, status, { actorId: null, source: 'vendor' }, trx);
      return inserted;
    });

    this.events.emit('compliance.kyc.submitted', {
      userId,
      referenceId: result.referenceId,
      provider: this.provider,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { ...toDto(row), verificationUrl: result.verificationUrl };
  }

  /**
   * Idempotent vendor-decision apply (polling + webhook). No-op when the latest record
   * already holds the mapped status. `reason`/`documentTypes`/`riskSignals` are only
   * overwritten when the caller supplies them, and `decidedAt` is stamped only on an
   * actual decision, so a bare status reconcile never blanks out an earlier one. Emits
   * `compliance.kyc.high_risk_signal_detected` when the supplied `riskSignals` (never a
   * preserved prior value) trip `warrantsHighRiskTag`.
   *
   * `opts.receivedAt` (when the caller has it - the `kyc-decision-sync` job path always
   * does, stamped at webhook-arrival time in the router, BEFORE the job queue can
   * reorder anything) is a monotonicity guard: a decision older than the one already on
   * file for this referenceId is refused, not applied. The job queue does not honour
   * `orderingKey` (see bullmq-job-queue.ts), so two decisions for the same reference can
   * reach here out of arrival order after a retry; without this guard the LATER-arriving
   * (but actually OLDER) decision would win and silently overwrite a newer, correct one.
   * A caller with no `receivedAt` (eg a direct `reconcile` call with no job path behind
   * it) skips the guard entirely - always applies, exactly as before.
   *
   * A vendor `approved` is downgraded to `resubmission_requested` when the checks this
   * call is about to persist (`opts.checks`, falling back to the existing row's `checks`
   * when the caller supplies none - the SAME value written below, so the gate can never
   * evaluate a different set of checks than the one that ends up on the row) contain any
   * non-`approved` entry - see `compliance/AGENTS.md` > KYC workflow completeness.
   */
  // referenceId is the KYC vendor's own reference, not an internal Uuid - stays a plain string.
  async reconcile(
    referenceId: string,
    vendorStatus: KycVendorStatus,
    opts: {
      reason?: string;
      documentTypes?: KycDocument['type'][];
      riskSignals?: KycRiskSignals;
      checks?: KycCheckResult[];
      receivedAt?: Date;
    } = {},
  ) {
    const [existing] = await this.drizzle.db
      .select()
      .from(kycVerification)
      .where(eq(kycVerification.referenceId, referenceId))
      .orderBy(desc(kycVerification.createdAt))
      .limit(1);
    if (!existing) {
      return null;
    }

    const mappedStatus = mapVendorStatus(vendorStatus);
    const persistedChecks = opts.checks ?? existing.checks ?? undefined;
    const incompleteCheck =
      mappedStatus === 'approved' ? findIncompleteCheck(persistedChecks) : undefined;
    const status = incompleteCheck ? 'resubmission_requested' : mappedStatus;
    const reasonFromThisReconcile = incompleteCheck
      ? describeIncompleteCheck(incompleteCheck)
      : opts.reason;
    const decisionReason = reasonFromThisReconcile ?? existing.decisionReason;

    if (existing.status === status && existing.decidedAt) {
      return toDto(existing);
    }

    if (
      opts.receivedAt &&
      existing.decisionReceivedAt &&
      opts.receivedAt < existing.decisionReceivedAt
    ) {
      logger.warn(
        { referenceId, incoming: opts.receivedAt, current: existing.decisionReceivedAt },
        'stale KYC decision refused: a newer decision is already applied for this reference',
      );
      return toDto(existing);
    }

    const decided = isDecided(status);
    const row = await this.drizzle.db.transaction(async (trx) => {
      const updated = findOneOrThrow(
        await trx
          .update(kycVerification)
          .set({
            status,
            decisionReason,
            documentTypes: opts.documentTypes ?? existing.documentTypes,
            riskSignals: opts.riskSignals ?? existing.riskSignals,
            checks: persistedChecks ?? null,
            decidedAt: decided ? new Date() : existing.decidedAt,
            decisionReceivedAt: opts.receivedAt ?? existing.decisionReceivedAt,
          })
          .where(eq(kycVerification.id, existing.id))
          .returning(),
        new KycVerificationNotFoundError(existing.id),
      );
      await this.statusWriter.setStatus(
        existing.userId,
        status,
        { actorId: null, source: 'webhook', reason: reasonFromThisReconcile },
        trx,
      );
      return updated;
    });
    if (opts.riskSignals && warrantsHighRiskTag(opts.riskSignals)) {
      this.events.emit('compliance.kyc.high_risk_signal_detected', {
        userId: existing.userId,
        referenceId,
        vpnOrTorDetected: opts.riskSignals.vpnOrTorDetected,
        dataCenterIpDetected: opts.riskSignals.dataCenterIpDetected,
        duplicateDeviceDetected: opts.riskSignals.duplicateDeviceDetected,
        highRiskCountryDetected: opts.riskSignals.highRiskCountryDetected,
      });
    }
    return toDto(row);
  }

  /**
   * `kyc-decision-sync` job handler, run off the webhook request path. Enriches the
   * reconcile through `resolveDecision`/`resolveRiskSignals` when the bound adapter
   * implements them, falling back to a status-only reconcile when it does not. Errors
   * (notably `PlayerNotFoundError`) propagate so the job queue retries the decision -
   * see `compliance/AGENTS.md` > Webhook -> job flow. `receivedAt` is the webhook's
   * arrival time (stamped by the router before enqueue, carried on the job payload) -
   * passed through to `reconcile` as the monotonicity watermark so a job that runs
   * out of arrival order (the driver ignores `orderingKey`) can't overwrite a newer
   * decision with a stale one.
   */
  async syncDecision(referenceId: string, status: KycVendorStatus, receivedAt?: Date) {
    const riskSignals = this.kycAdapter.resolveRiskSignals
      ? await this.kycAdapter.resolveRiskSignals(referenceId)
      : undefined;
    if (!this.kycAdapter.resolveDecision) {
      return this.reconcile(referenceId, status, { riskSignals, receivedAt });
    }
    const decision = await this.kycAdapter.resolveDecision(referenceId);
    return this.reconcile(referenceId, decision.status, {
      reason: decision.decisionReason,
      documentTypes: decision.documentTypes,
      checks: decision.checks,
      riskSignals,
      receivedAt,
    });
  }

  async getForPlayer(userId: User['id']): Promise<PlayerKycView> {
    const rows = await this.drizzle.db
      .select()
      .from(kycVerification)
      .where(eq(kycVerification.userId, userId))
      .orderBy(desc(kycVerification.createdAt));
    return { current: rows[0] ? toDto(rows[0]) : null, history: rows.map(toDto) };
  }

  /**
   * Deposit-event hook: flips a currently-approved player to `resubmission_requested`
   * once cumulative deposits cross a fresh per-currency threshold band. Idempotent twice
   * over: skips unless presently approved, and the watermark stops a re-approved
   * high-roller re-firing on every later deposit.
   */
  async handleDeposit(userId: User['id']) {
    const [current] = await this.drizzle.db
      .select({ currency: player.currency, kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId));
    if (!current || normalizeKycStatus(current.kycStatus) !== 'approved') {
      return;
    }

    const [deposited] = await this.drizzle.db
      .select({ total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)` })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
          eq(walletTransaction.currency, current.currency),
        ),
      );

    const [lastFire] = await this.drizzle.db
      .select({ triggerDeposits: kycVerification.triggerDeposits })
      .from(kycVerification)
      .where(
        and(
          eq(kycVerification.userId, userId),
          eq(kycVerification.triggeredBy, 'reverify_threshold'),
        ),
      )
      .orderBy(desc(kycVerification.createdAt))
      .limit(1);

    const totalDeposits = deposited?.total ?? '0';
    const snapshot = {
      totalDeposits,
      currency: current.currency,
      lastTriggeredDeposits: lastFire?.triggerDeposits ?? '0',
    };
    const thresholds = this.platformConfig?.kyc?.reverifyThresholds;
    if (!this.reKycTrigger.requiresReverify(snapshot, thresholds)) {
      return;
    }

    const reason = `Cumulative deposits ${totalDeposits} ${snapshot.currency} crossed the re-KYC threshold`;
    await this.drizzle.db.insert(kycVerification).values({
      userId,
      provider: this.provider,
      referenceId: `reverify-${userId}-${Date.now()}`,
      status: 'resubmission_requested',
      documentTypes: [],
      triggeredBy: 'reverify_threshold',
      triggerDeposits: totalDeposits,
      decisionReason: reason,
    });
    await this.statusWriter.setStatus(userId, 'resubmission_requested', {
      actorId: null,
      source: 'reverify',
      reason,
    });
    this.events.emit('compliance.kyc.reverify_required', { userId, reason });
  }

  /**
   * Shared transaction body for `requestResubmission`/`overrideStatus`: inserts the
   * manual `kyc_verification` history row and calls `KYC_STATUS_WRITER.setStatus` in
   * the SAME transaction (extracted so the two documented locking/idempotency rules
   * in `compliance/AGENTS.md` > Admin KYC actions cannot silently diverge between the
   * two call sites). Caller has already run the idempotency pre-check
   * (`requirePlayerRowForUpdate` + a status compare) before calling this.
   */
  private async applyManualDecision(
    trx: DrizzleTx,
    params: {
      userId: User['id'];
      status: KycStatus;
      reason: string;
      actorId: User['id'];
      referenceIdPrefix: string;
      decidedAt: Date | null;
    },
  ) {
    const inserted = findOneOrThrow(
      await trx
        .insert(kycVerification)
        .values({
          userId: params.userId,
          provider: MANUAL_PROVIDER,
          referenceId: `${params.referenceIdPrefix}-${params.userId}-${Date.now()}`,
          status: params.status,
          documentTypes: [],
          triggeredBy: 'manual',
          decisionReason: params.reason,
          decidedAt: params.decidedAt,
        })
        .returning(),
      new KycVerificationNotFoundError(params.userId),
    );
    await this.statusWriter.setStatus(
      params.userId,
      params.status,
      { actorId: params.actorId, reason: params.reason, source: 'manual' },
      trx,
    );
    return toDto(inserted);
  }

  /**
   * Admin-initiated: requests the player resubmit documents. Idempotent on a repeat
   * call while the player is already at `resubmission_requested` - no duplicate history
   * row, no duplicate `compliance.kyc.updated` emit. See `compliance/AGENTS.md` >
   * Admin KYC actions for why the `FOR UPDATE` lock has to sit inside the transaction.
   */
  async requestResubmission(userId: User['id'], reason: string, actorId: User['id']) {
    return this.drizzle.db.transaction(async (trx) => {
      const current = await this.requirePlayerRowForUpdate(userId, trx);
      if (normalizeKycStatus(current.kycStatus) === 'resubmission_requested') {
        return toDto(await this.latestVerificationOrThrow(userId, trx));
      }

      return this.applyManualDecision(trx, {
        userId,
        status: 'resubmission_requested',
        reason,
        actorId,
        referenceIdPrefix: 'manual-resubmit',
        decidedAt: null,
      });
    });
  }

  /**
   * Admin-initiated: forces the player to an operator-chosen status, guarded by the
   * router's `compliance:override-limit`. `resolveManualStatus` remaps an `approved`
   * choice to `manually_overridden`; every other choice is written verbatim. Idempotent
   * on a repeat call resolving to the status the player already holds. Rationale for
   * both: `compliance/AGENTS.md` > Admin KYC actions.
   */
  async overrideStatus(
    userId: User['id'],
    status: KycOverrideStatus,
    reason: string,
    actorId: User['id'],
  ) {
    const resolvedStatus = resolveManualStatus(status);
    return this.drizzle.db.transaction(async (trx) => {
      const current = await this.requirePlayerRowForUpdate(userId, trx);
      if (normalizeKycStatus(current.kycStatus) === normalizeKycStatus(resolvedStatus)) {
        return toDto(await this.latestVerificationOrThrow(userId, trx));
      }

      return this.applyManualDecision(trx, {
        userId,
        status: resolvedStatus,
        reason,
        actorId,
        referenceIdPrefix: 'manual-override',
        decidedAt: isDecided(resolvedStatus) ? new Date() : null,
      });
    });
  }

  /**
   * Admin-initiated: approves every listed player through the same
   * `overrideStatus('approved', ...)` path, so a bulk approval is recorded identically
   * to a single one. Bounded fan-out with per-player error isolation - one failure is
   * captured as a result row rather than aborting the batch, and the returned message
   * is a fixed string, never the raw exception text (`compliance/AGENTS.md`).
   */
  async bulkApprove(
    userIds: User['id'][],
    reason: string,
    actorId: User['id'],
  ): Promise<BulkApproveKycResult[]> {
    return mapConcurrent(userIds, BULK_APPROVE_CONCURRENCY, async (userId) => {
      try {
        await this.overrideStatus(userId, 'approved', reason, actorId);
        return { userId, success: true, error: null };
      } catch (err) {
        // Fixed string on the wire, regardless of error type - never the raw exception
        // text (it can carry the userId, eg PlayerNotFoundError, or a driver/constraint
        // message). The distinction itself ("not found" vs some other failure) is
        // already an existence oracle over an id an admin didn't otherwise confirm; the
        // full error is logged server-side (with userId) for ops.
        logger.error({ err, userId }, 'bulk KYC approve failed for player');
        return { userId, success: false, error: 'Failed to approve KYC' };
      }
    });
  }

  private async requirePlayerRowForUpdate(userId: User['id'], tx: DrizzleTx) {
    const rows = await tx
      .select({ kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId))
      .for('update');
    const row = rows[0];
    if (!row) {
      throw new PlayerNotFoundError(userId);
    }
    return row;
  }

  private async latestVerificationOrThrow(userId: User['id'], tx: DrizzleTx = this.drizzle.db) {
    const rows = await tx
      .select()
      .from(kycVerification)
      .where(eq(kycVerification.userId, userId))
      .orderBy(desc(kycVerification.createdAt))
      .limit(1);
    return findOneOrThrow(rows, new KycVerificationNotFoundError(userId));
  }
}
