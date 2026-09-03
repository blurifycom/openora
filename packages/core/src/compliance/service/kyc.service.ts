import { randomUUID } from 'node:crypto';
import {
  DrizzleService,
  createDomainError,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  mapConcurrent,
  serializeRow,
  withAdvisoryXactLock,
  type EventBus,
} from '@openora/core/server';
import {
  normalizeKycStatus,
  type KycAdapter,
  type KycCheckResult,
  type KycDocument,
  type KycRiskSignals,
  type KycStatusWriter,
  type KycStatusTransition,
  type KycTier,
  type KycVendorStatus,
  type KycStatus,
  type PlatformConfig,
  type IdentityReader,
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
  PlayerKycSummaryView,
  KycVerificationSummary,
  KycOverrideStatus,
  BulkApproveKycResult,
} from '../contract/index.js';
import { CumulativeDepositReKycTrigger, type ReKycTrigger } from './re-kyc-trigger.js';

const logger = createLogger('compliance-kyc');

type DrizzleTx =
  | DrizzleService['db']
  | Parameters<Parameters<DrizzleService['db']['transaction']>[0]>[0];

type KycReconcileOutcome = {
  row: KycVerification;
  playerTransition: KycStatusTransition | null;
  changed: boolean;
  previousStatus: KycStatus;
  reason: string | null;
};

const DEFAULT_PROVIDER = 'mock';
const MANUAL_PROVIDER = 'manual';
const BULK_APPROVE_CONCURRENCY = 10;

export const PlayerNotFoundError = makeNotFoundError('Player');

export const KycVerificationNotFoundError = makeNotFoundError('KycVerification');

// Fail-closed: a referenceId is supposed to belong to one player. If rows sharing one
// ever don't, that's a vendor reference collision - refuse to touch any of them rather
// than risk writing one player's decision onto another player's kyc_verification row.
export const KycReferenceOwnerMismatchError = createDomainError<[referenceId: string]>(
  'KycReferenceOwnerMismatchError',
  (referenceId) =>
    `kyc_verification rows sharing referenceId ${referenceId} belong to different users`,
);

// The webhook-supplied tier and KycAdapter.resolveDecision's tier disagree for the same
// referenceId - the vendor's own signals are inconsistent, so refuse the decision rather
// than guess which tier it actually belongs to.
export const KycReferenceTierMismatchError = createDomainError<[referenceId: string]>(
  'KycReferenceTierMismatchError',
  (referenceId) =>
    `webhook-supplied tier and resolveDecision-supplied tier disagree for referenceId ${referenceId}`,
);

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

function toSummaryDto(dto: NonNullable<PlayerKycView['basic']['current']>): KycVerificationSummary {
  return {
    tier: dto.tier,
    status: dto.status,
    documentTypes: dto.documentTypes,
    submittedAt: dto.submittedAt,
    decidedAt: dto.decidedAt,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

// Player-facing projection: strips riskSignals, checks, decisionReason, provider, and
// referenceId - those are fraud-detection internals, admin-only via getPlayerKyc.
export function toPlayerSummaryView(view: PlayerKycView): PlayerKycSummaryView {
  const summarizeTier = (tier: PlayerKycView['basic']) => ({
    current: tier.current ? toSummaryDto(tier.current) : null,
    history: tier.history.map(toSummaryDto),
  });
  return {
    basic: summarizeTier(view.basic),
    advanced: summarizeTier(view.advanced),
  };
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
  identityReader: IdentityReader;
  platformConfig?: PlatformConfig;
  reKycTrigger?: ReKycTrigger;
};

export class KycVerificationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly kycAdapter: KycAdapter;
  private readonly statusWriter: KycStatusWriter;
  private readonly identityReader: IdentityReader;
  private readonly platformConfig?: PlatformConfig;
  private readonly reKycTrigger: ReKycTrigger;

  constructor(deps: KycVerificationDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.kycAdapter = deps.kycAdapter;
    this.statusWriter = deps.statusWriter;
    this.identityReader = deps.identityReader;
    this.platformConfig = deps.platformConfig;
    this.reKycTrigger = deps.reKycTrigger ?? new CumulativeDepositReKycTrigger();
  }

  private get provider() {
    return this.platformConfig?.kyc?.provider ?? DEFAULT_PROVIDER;
  }

  private async emitUpdated(params: {
    userId: User['id'];
    tier: KycTier;
    status: KycStatus;
    previousStatus: KycStatus | null;
    playerTransition: KycStatusTransition | null;
    actorId: User['id'] | null;
    reason: string | null;
    source: 'vendor' | 'manual' | 'webhook' | 'reverify';
  }) {
    if (params.tier === 'basic' && !params.playerTransition) {
      return;
    }
    if (params.tier === 'advanced' && params.previousStatus === params.status) {
      return;
    }
    this.events.emit('compliance.kyc.updated', {
      userId: params.userId,
      playerId:
        params.playerTransition?.playerId ??
        (await this.identityReader.getPlayerIdByUserIdSafe(params.userId)),
      actorId: params.actorId,
      status: params.status,
      previousStatus:
        params.playerTransition?.previousStatus ?? params.previousStatus ?? 'not_started',
      reason: params.reason,
      source: params.source,
      tier: params.tier,
    });
  }

  /**
   * The whole body - including the vendor call - runs under a transaction-scoped advisory
   * lock keyed on (userId, tier), so two concurrent submits (a double-clicked "start
   * verification", or a retried request) can never both reach the vendor: the second caller
   * blocks until the first's transaction commits, then sees the first's row and returns it
   * instead of minting a second vendor session. Scoping the lock (and the DB dedup check) to
   * referenceId alone wouldn't do this - a vendor that mints a fresh session per call (eg
   * Didit) gives each concurrent caller a DIFFERENT referenceId, so the
   * (userId, referenceId, tier) unique constraint never collides. This must gate the vendor
   * call itself, not just the insert, or the operator still ends up with two live vendor
   * sessions even though only one row survives here.
   */
  async submit(userId: User['id'], input: SubmitKycInput, meta?: ClientMeta) {
    const outcome = await this.drizzle.db.transaction((trx) =>
      withAdvisoryXactLock(trx, `kyc-submit:${userId}:${input.tier}`, async () => {
        // Scoped to (userId, tier), NOT referenceId: a fresh Advanced resubmission gets a
        // new vendor session/referenceId, so a referenceId-scoped lookup would find nothing
        // and default previousStatus to 'not_started' even when a prior (rejected) tier
        // history exists - corrupting the audit-log's before.kycStatus. latestVerification
        // captures the true prior state across vendor sessions for this tier.
        const previous = await this.latestVerification(userId, input.tier, trx);

        // An active, undecided session already exists - collapse onto it instead of
        // minting a second one. NOT resubmission_requested: that status explicitly invites
        // a fresh submission, so it must fall through to a real new vendor call below.
        if (previous && (previous.status === 'pending' || previous.status === 'not_started')) {
          logger.info(
            { userId, tier: input.tier, existingId: previous.id },
            'kyc submit collapsed onto an in-flight session',
          );
          return { duplicate: true as const, row: previous };
        }

        const result = await this.kycAdapter.submit(
          userId,
          input.documents.map((d) => ({ type: d.type, frontUrl: d.frontUrl, backUrl: d.backUrl })),
          input.tier,
        );
        const mappedStatus = mapVendorStatus(result.status);
        const incompleteCheck =
          mappedStatus === 'approved' ? findIncompleteCheck(result.checks) : undefined;
        const status = incompleteCheck ? 'resubmission_requested' : mappedStatus;
        const decisionReason = incompleteCheck ? describeIncompleteCheck(incompleteCheck) : null;
        const decided = isDecided(status);

        const inserted = findOneOrThrow(
          await trx
            .insert(kycVerification)
            .values({
              userId,
              provider: this.provider,
              referenceId: result.referenceId,
              tier: input.tier,
              status,
              documentTypes: input.documents.map((d) => d.type),
              decisionReason,
              checks: result.checks ?? null,
              triggeredBy: 'submission',
              decidedAt: decided ? new Date() : null,
              decisionReceivedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [kycVerification.userId, kycVerification.referenceId, kycVerification.tier],
              set: {
                userId,
                provider: this.provider,
                status,
                documentTypes: input.documents.map((d) => d.type),
                decisionReason,
                checks: result.checks ?? null,
                triggeredBy: 'submission',
                decidedAt: decided ? new Date() : null,
                decisionReceivedAt: new Date(),
              },
            })
            .returning(),
          new KycVerificationNotFoundError(userId),
        );
        const playerTransition =
          input.tier === 'basic'
            ? await this.statusWriter.setStatus(
                userId,
                status,
                { actorId: null, source: 'vendor' },
                trx,
              )
            : null;
        // compliance.kyc.updated is the audit-visible status-change event (docs/standards/
        // compliance.md): emitted here, inside the transaction, so it can never be dropped
        // by a crash between commit and a post-commit emit.
        await this.emitUpdated({
          userId,
          tier: input.tier,
          status,
          previousStatus: previous?.status ?? null,
          playerTransition,
          actorId: null,
          reason: decisionReason,
          source: 'vendor',
        });
        return {
          duplicate: false as const,
          row: inserted,
          referenceId: result.referenceId,
          verificationUrl: result.verificationUrl,
        };
      }),
    );

    if (outcome.duplicate) {
      return { ...toDto(outcome.row), verificationUrl: undefined };
    }

    this.events.emit('compliance.kyc.submitted', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      referenceId: outcome.referenceId,
      provider: this.provider,
      tier: input.tier,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { ...toDto(outcome.row), verificationUrl: outcome.verificationUrl };
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
   * non-`approved` entry.
   *
   * `opts.tier` scopes the decision to one tier's row when the adapter could attribute it
   * (see `KycResult.tier`); when absent, the decision fans out to every row sharing this
   * referenceId - the documented "shared vendor workflow" behavior. Either way, every row
   * found for `referenceId` must belong to the same `userId` - a vendor reference is
   * supposed to identify one player, and a collision (one vendor reference reused across
   * players) must fail closed rather than let one player's decision write another's row.
   */
  // referenceId is the KYC vendor's own reference, not an internal Uuid - stays a plain string.
  async reconcile(
    referenceId: string,
    vendorStatus: KycVendorStatus,
    opts: {
      tier?: KycTier;
      reason?: string;
      documentTypes?: KycDocument['type'][];
      riskSignals?: KycRiskSignals;
      checks?: KycCheckResult[];
      receivedAt?: Date;
    } = {},
  ) {
    const outcomes = await this.drizzle.db.transaction(async (trx) => {
      const rows = await trx
        .select()
        .from(kycVerification)
        .where(eq(kycVerification.referenceId, referenceId))
        .orderBy(desc(kycVerification.createdAt))
        .for('update');
      const [firstRow] = rows;
      if (!firstRow) {
        return [];
      }
      const ownerUserId = firstRow.userId;
      if (rows.some((row) => row.userId !== ownerUserId)) {
        throw new KycReferenceOwnerMismatchError(referenceId);
      }
      const targetRows = opts.tier ? rows.filter((row) => row.tier === opts.tier) : rows;
      const reconciled: KycReconcileOutcome[] = [];

      for (const row of targetRows) {
        const mappedStatus = mapVendorStatus(vendorStatus);
        const persistedChecks = opts.checks ?? row.checks ?? undefined;
        const incompleteCheck =
          mappedStatus === 'approved' ? findIncompleteCheck(persistedChecks) : undefined;
        const status = incompleteCheck ? 'resubmission_requested' : mappedStatus;
        const reasonFromThisReconcile = incompleteCheck
          ? describeIncompleteCheck(incompleteCheck)
          : opts.reason;
        const decisionReason = reasonFromThisReconcile ?? row.decisionReason;

        if (row.status === status && row.decidedAt) {
          reconciled.push({
            row,
            playerTransition: null,
            changed: false,
            previousStatus: row.status,
            reason: null,
          });
          continue;
        }

        if (opts.receivedAt && row.decisionReceivedAt && opts.receivedAt < row.decisionReceivedAt) {
          logger.warn(
            { referenceId, incoming: opts.receivedAt, current: row.decisionReceivedAt },
            'stale KYC decision refused: a newer decision is already applied for this reference',
          );
          reconciled.push({
            row,
            playerTransition: null,
            changed: false,
            previousStatus: row.status,
            reason: null,
          });
          continue;
        }

        const updated = findOneOrThrow(
          await trx
            .update(kycVerification)
            .set({
              status,
              decisionReason,
              documentTypes: opts.documentTypes ?? row.documentTypes,
              riskSignals: opts.riskSignals ?? row.riskSignals,
              checks: persistedChecks ?? null,
              decidedAt: isDecided(status) ? new Date() : row.decidedAt,
              decisionReceivedAt: opts.receivedAt ?? row.decisionReceivedAt,
            })
            .where(eq(kycVerification.id, row.id))
            .returning(),
          new KycVerificationNotFoundError(row.id),
        );
        const playerTransition =
          row.tier === 'basic'
            ? await this.statusWriter.setStatus(
                row.userId,
                status,
                { actorId: null, source: 'webhook', reason: reasonFromThisReconcile },
                trx,
              )
            : null;
        // compliance.kyc.updated is the audit-visible status-change event (docs/standards/
        // compliance.md): emitted here, inside the transaction, so it can never be dropped
        // by a crash between commit and a post-commit emit.
        await this.emitUpdated({
          userId: row.userId,
          tier: row.tier,
          status,
          previousStatus: row.status,
          playerTransition,
          actorId: null,
          reason: reasonFromThisReconcile ?? null,
          source: 'webhook',
        });
        reconciled.push({
          row: updated,
          playerTransition,
          changed: true,
          previousStatus: row.status,
          reason: reasonFromThisReconcile ?? null,
        });
      }

      return reconciled;
    });

    if (outcomes.length === 0) {
      return null;
    }

    // Emitted once per reconcile() call, not once per row: the signal describes the
    // vendor SESSION (referenceId), not a tier - a shared-workflow decision touching
    // both tiers is still exactly one real signal.
    const anyChanged = outcomes.some((outcome) => outcome.changed);
    if (anyChanged && opts.riskSignals && warrantsHighRiskTag(opts.riskSignals)) {
      const [primaryOutcome] = outcomes;
      if (primaryOutcome) {
        this.events.emit('compliance.kyc.high_risk_signal_detected', {
          userId: primaryOutcome.row.userId,
          playerId: await this.identityReader.getPlayerIdByUserIdSafe(primaryOutcome.row.userId),
          referenceId,
          tier: primaryOutcome.row.tier,
          vpnOrTorDetected: opts.riskSignals.vpnOrTorDetected,
          dataCenterIpDetected: opts.riskSignals.dataCenterIpDetected,
          duplicateDeviceDetected: opts.riskSignals.duplicateDeviceDetected,
          highRiskCountryDetected: opts.riskSignals.highRiskCountryDetected,
        });
      }
    }

    const primary = outcomes.find((outcome) => outcome.changed) ?? outcomes[0];
    return primary ? toDto(primary.row) : null;
  }

  /**
   * `kyc-decision-sync` job handler, run off the webhook request path. Enriches the
   * reconcile through `resolveDecision`/`resolveRiskSignals` when the bound adapter
   * implements them, falling back to a status-only reconcile when it does not. Errors
   * (notably `PlayerNotFoundError`) propagate so the job queue retries the decision.
   * `receivedAt` is the webhook's
   * arrival time (stamped by the router before enqueue, carried on the job payload) -
   * passed through to `reconcile` as the monotonicity watermark so a job that runs
   * out of arrival order (the driver ignores `orderingKey`) can't overwrite a newer
   * decision with a stale one.
   *
   * `webhookTier` is whatever `parseWebhook` attributed the decision to, carried on the
   * job payload. When `resolveDecision` ALSO reports a tier and it disagrees with
   * `webhookTier`, the vendor's own signals are inconsistent - refuse the decision rather
   * than guess. The resolved tier (webhook's, falling back to resolveDecision's) is what
   * scopes `reconcile` to one row; absent both, `reconcile` keeps the shared-workflow
   * fan-out.
   */
  async syncDecision(
    referenceId: string,
    status: KycVendorStatus,
    receivedAt?: Date,
    webhookTier?: KycTier,
  ) {
    const riskSignals = this.kycAdapter.resolveRiskSignals
      ? await this.kycAdapter.resolveRiskSignals(referenceId)
      : undefined;
    if (!this.kycAdapter.resolveDecision) {
      return this.reconcile(referenceId, status, { tier: webhookTier, riskSignals, receivedAt });
    }
    const decision = await this.kycAdapter.resolveDecision(referenceId);
    if (webhookTier && decision.tier && webhookTier !== decision.tier) {
      throw new KycReferenceTierMismatchError(referenceId);
    }
    return this.reconcile(referenceId, decision.status, {
      tier: webhookTier ?? decision.tier,
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
    const basic = rows.filter((row) => row.tier === 'basic').map(toDto);
    const advanced = rows.filter((row) => row.tier === 'advanced').map(toDto);
    return {
      basic: { current: basic[0] ?? null, history: basic },
      advanced: { current: advanced[0] ?? null, history: advanced },
    };
  }

  /**
   * Deposit-event hook: flips a currently-approved player to `resubmission_requested`
   * once cumulative deposits cross a fresh per-currency threshold band. Idempotent twice
   * over: skips unless presently approved, and the watermark stops a re-approved
   * high-roller re-firing on every later deposit.
   */
  async handleDeposit(userId: User['id']) {
    const [current] = await this.drizzle.db
      .select({ id: player.id, currency: player.currency, kycStatus: player.kycStatus })
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
          eq(kycVerification.tier, 'basic'),
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
    await this.drizzle.db.transaction(async (trx) => {
      await trx.insert(kycVerification).values({
        userId,
        provider: this.provider,
        referenceId: `reverify-${randomUUID()}`,
        tier: 'basic',
        status: 'resubmission_requested',
        documentTypes: [],
        triggeredBy: 'reverify_threshold',
        triggerDeposits: totalDeposits,
        decisionReason: reason,
      });
      const playerTransition = await this.statusWriter.setStatus(
        userId,
        'resubmission_requested',
        {
          actorId: null,
          source: 'reverify',
          reason,
        },
        trx,
      );
      // compliance.kyc.updated is the audit-visible status-change event (docs/standards/
      // compliance.md): emitted here, inside the transaction, so it can never be dropped
      // by a crash between commit and a post-commit emit.
      await this.emitUpdated({
        userId,
        tier: 'basic',
        status: 'resubmission_requested',
        previousStatus: current.kycStatus,
        playerTransition,
        actorId: null,
        reason,
        source: 'reverify',
      });
    });
    this.events.emit('compliance.kyc.reverify_required', {
      userId,
      playerId: current.id,
      reason,
      tier: 'basic',
    });
  }

  /**
   * Shared transaction body for `requestResubmission`/`overrideStatus`: inserts the
   * manual `kyc_verification` history row and calls `KYC_STATUS_WRITER.setStatus` in
   * the SAME transaction so the locking and idempotency rules cannot diverge between
   * the two call sites. Caller has already run the idempotency pre-check
   * (`requirePlayerRowForUpdate` + a status compare) before calling this.
   */
  private async applyManualDecision(
    trx: DrizzleTx,
    params: {
      userId: User['id'];
      status: KycStatus;
      reason: string;
      actorId: User['id'];
      tier: KycTier;
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
          referenceId: `${params.referenceIdPrefix}-${params.userId}-${randomUUID()}`,
          tier: params.tier,
          status: params.status,
          documentTypes: [],
          triggeredBy: 'manual',
          decisionReason: params.reason,
          decidedAt: params.decidedAt,
        })
        .returning(),
      new KycVerificationNotFoundError(params.userId),
    );
    const playerTransition =
      params.tier === 'basic'
        ? await this.statusWriter.setStatus(
            params.userId,
            params.status,
            { actorId: params.actorId, reason: params.reason, source: 'manual' },
            trx,
          )
        : null;
    return { row: toDto(inserted), playerTransition };
  }

  /**
   * Admin-initiated: requests the player resubmit documents. Idempotent on a repeat
   * call while the player is already at `resubmission_requested` - no duplicate history
   * row or `compliance.kyc.updated` emit.
   */
  async requestResubmission(
    userId: User['id'],
    tier: KycTier,
    reason: string,
    actorId: User['id'],
  ) {
    const outcome = await this.drizzle.db.transaction(async (trx) => {
      const current = await this.requirePlayerRowForUpdate(userId, trx);
      const latest = await this.latestVerification(userId, tier, trx);
      const currentStatus = tier === 'basic' ? current.kycStatus : latest?.status;
      if (currentStatus === 'resubmission_requested') {
        return {
          row: latest ? toDto(latest) : null,
          playerTransition: null,
          previousStatus: currentStatus,
          changed: false,
        };
      }
      const applied = await this.applyManualDecision(trx, {
        userId,
        tier,
        status: 'resubmission_requested',
        reason,
        actorId,
        referenceIdPrefix: 'manual-resubmit',
        decidedAt: null,
      });
      // compliance.kyc.updated is the audit-visible status-change event (docs/standards/
      // compliance.md): emitted here, inside the transaction, so it can never be dropped
      // by a crash between commit and a post-commit emit.
      await this.emitUpdated({
        userId,
        tier,
        status: 'resubmission_requested',
        previousStatus: currentStatus ?? null,
        playerTransition: applied.playerTransition,
        actorId,
        reason,
        source: 'manual',
      });
      return { ...applied, previousStatus: currentStatus ?? null, changed: true };
    });
    if (!outcome.row) {
      throw new KycVerificationNotFoundError(userId);
    }
    return outcome.row;
  }

  /**
   * Admin-initiated: forces the player to an operator-chosen status, guarded by the
   * router's `compliance:override-limit`. `resolveManualStatus` remaps an `approved`
   * choice to `manually_overridden`; every other choice is written verbatim. Idempotent
   * on a repeat call resolving to the status the player already holds.
   */
  async overrideStatus(
    userId: User['id'],
    tier: KycTier,
    status: KycOverrideStatus,
    reason: string,
    actorId: User['id'],
  ) {
    const resolvedStatus = resolveManualStatus(status);
    const outcome = await this.drizzle.db.transaction(async (trx) => {
      const current = await this.requirePlayerRowForUpdate(userId, trx);
      const latest = await this.latestVerification(userId, tier, trx);
      const currentStatus = tier === 'basic' ? current.kycStatus : latest?.status;
      if (
        currentStatus &&
        normalizeKycStatus(currentStatus) === normalizeKycStatus(resolvedStatus)
      ) {
        return {
          row: latest ? toDto(latest) : null,
          playerTransition: null,
          previousStatus: currentStatus ?? null,
          changed: false,
        };
      }
      const applied = await this.applyManualDecision(trx, {
        userId,
        tier,
        status: resolvedStatus,
        reason,
        actorId,
        referenceIdPrefix: 'manual-override',
        decidedAt: isDecided(resolvedStatus) ? new Date() : null,
      });
      // compliance.kyc.updated is the audit-visible status-change event (docs/standards/
      // compliance.md): emitted here, inside the transaction, so it can never be dropped
      // by a crash between commit and a post-commit emit.
      await this.emitUpdated({
        userId,
        tier,
        status: resolvedStatus,
        previousStatus: currentStatus ?? null,
        playerTransition: applied.playerTransition,
        actorId,
        reason,
        source: 'manual',
      });
      return { ...applied, previousStatus: currentStatus ?? null, changed: true };
    });
    if (!outcome.row) {
      throw new KycVerificationNotFoundError(userId);
    }
    return outcome.row;
  }

  /**
   * Admin-initiated: approves every listed player through the same
   * `overrideStatus('approved', ...)` path, so a bulk approval is recorded identically
   * to a single one. Bounded fan-out with per-player error isolation - one failure is
   * captured as a result row rather than aborting the batch, and the returned message
   * is a fixed string, never the raw exception text.
   */
  async bulkApprove(
    userIds: User['id'][],
    tier: KycTier,
    reason: string,
    actorId: User['id'],
  ): Promise<BulkApproveKycResult[]> {
    return mapConcurrent(userIds, BULK_APPROVE_CONCURRENCY, async (userId) => {
      try {
        await this.overrideStatus(userId, tier, 'approved', reason, actorId);
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

  private async latestVerification(
    userId: User['id'],
    tier: KycTier,
    tx: DrizzleTx = this.drizzle.db,
  ) {
    const rows = await tx
      .select()
      .from(kycVerification)
      .where(and(eq(kycVerification.userId, userId), eq(kycVerification.tier, tier)))
      .orderBy(desc(kycVerification.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
