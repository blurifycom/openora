import { randomUUID } from 'node:crypto';
import {
  DrizzleService,
  createDomainError,
  createLogger,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  mapConcurrent,
  reportError,
  serializeRow,
  sumInPivot,
  withAdvisoryXactLock,
  type EventBus,
} from '@openora/core/server';
import {
  isAdultDateOfBirth,
  normalizeKycStatus,
  resolveMinPlayerAge,
  type KycAdapter,
  type AuditWritePort,
  type ExchangeRateReader,
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
  type Player,
  type User,
  type WalletReader,
  ClientMeta,
  resolveExchangeRatePivot,
} from '@openora/core/contracts';
import { and, desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { kycVerification, type KycVerification } from '../schema/index.js';
import { player } from '@openora/core/pam/schema/profile';
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

const KycVerificationNotFoundError = makeNotFoundError('KycVerification');

export const KycResubmissionAlreadyRequestedError = makeConflictError(
  'KycResubmissionAlreadyRequestedError',
  'A resubmission is already requested for this tier',
);

const KYC_IN_PROGRESS_STATUSES: ReadonlySet<KycStatus> = new Set(['pending', 'not_started']);

export const KycVerificationInProgressError = makeConflictError(
  'KycVerificationInProgressError',
  'A verification of this tier is in progress: wait for its decision, or override the tier KYC status to close it first',
);

const KycReferenceOwnerMismatchError = createDomainError<[referenceId: string]>(
  'KycReferenceOwnerMismatchError',
  (referenceId) =>
    `kyc_verification rows sharing referenceId ${referenceId} belong to different users`,
);

const KycReferenceTierMismatchError = createDomainError<[referenceId: string]>(
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

export function isDecided(status: KycStatus) {
  const normalized = normalizeKycStatus(status);
  return (
    normalized === 'approved' || normalized === 'rejected' || normalized === 'manually_overridden'
  );
}

export function resolveManualStatus(status: KycOverrideStatus): KycStatus {
  return status === 'approved' ? 'manually_overridden' : status;
}

const UNDERAGE_REASON = 'underage';

const UNREADABLE_DATE_OF_BIRTH_REASON = 'date_of_birth_unreadable';

const VendorDateOfBirthSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => value.slice(0, 10));

type VendorDateOfBirth = { dateOfBirth?: string; underage: boolean; unreadable: boolean };

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

export function gateVendorDecision(
  vendorStatus: KycVendorStatus,
  checks: KycCheckResult[] | undefined,
  dob: VendorDateOfBirth,
): { status: KycStatus; reason?: string } {
  if (dob.underage) {
    return { status: 'rejected', reason: UNDERAGE_REASON };
  }
  const status = mapVendorStatus(vendorStatus);
  if (status !== 'approved') {
    return { status };
  }
  const incompleteCheck = findIncompleteCheck(checks);
  if (incompleteCheck) {
    return { status: 'resubmission_requested', reason: describeIncompleteCheck(incompleteCheck) };
  }
  if (dob.unreadable) {
    return { status: 'resubmission_requested', reason: UNREADABLE_DATE_OF_BIRTH_REASON };
  }
  return { status };
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
    exempt: dto.triggeredBy === 'exemption',
    submittedAt: dto.submittedAt,
    decidedAt: dto.decidedAt,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function toStandingVerification(dto: NonNullable<PlayerKycView['basic']['current']>) {
  return {
    status: normalizeKycStatus(dto.status),
    provider: dto.provider,
    documentTypes: dto.documentTypes,
    triggeredBy: dto.triggeredBy,
    decidedAt: dto.decidedAt,
    createdAt: dto.createdAt,
  };
}

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

export type KycVerificationDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  kycAdapter: KycAdapter;
  statusWriter: KycStatusWriter;
  identityReader: IdentityReader;
  platformConfig?: PlatformConfig;
  reKycTrigger?: ReKycTrigger;
  exchangeRateReader?: ExchangeRateReader;
  walletReader: WalletReader;
};

export class KycVerificationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly audit: AuditWritePort;
  private readonly kycAdapter: KycAdapter;
  private readonly statusWriter: KycStatusWriter;
  private readonly identityReader: IdentityReader;
  private readonly platformConfig?: PlatformConfig;
  private readonly reKycTrigger: ReKycTrigger;
  private readonly exchangeRateReader?: ExchangeRateReader;
  private readonly walletReader: WalletReader;

  constructor(deps: KycVerificationDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.audit = deps.audit;
    this.kycAdapter = deps.kycAdapter;
    this.statusWriter = deps.statusWriter;
    this.identityReader = deps.identityReader;
    this.platformConfig = deps.platformConfig;
    this.reKycTrigger = deps.reKycTrigger ?? new CumulativeDepositReKycTrigger();
    this.exchangeRateReader = deps.exchangeRateReader;
    this.walletReader = deps.walletReader;
  }

  private get provider() {
    return this.platformConfig?.kyc?.provider ?? DEFAULT_PROVIDER;
  }

  private async emitUpdated(
    trx: DrizzleTx,
    params: {
      userId: User['id'];
      playerId?: Player['id'];
      tier: KycTier;
      status: KycStatus;
      previousStatus: KycStatus | null;
      playerTransition: KycStatusTransition | null;
      actorId: User['id'] | null;
      reason: string | null;
      source: 'vendor' | 'manual' | 'webhook' | 'reverify' | 'exemption';
      auditRecorded?: true;
    },
  ) {
    if (params.tier === 'basic' && !params.playerTransition && !params.playerId) {
      return;
    }
    if (params.tier === 'advanced' && params.previousStatus === params.status) {
      return;
    }
    await this.events.emitInTransaction(trx, 'compliance.kyc.updated', {
      userId: params.userId,
      playerId:
        params.playerTransition?.playerId ??
        params.playerId ??
        (await this.identityReader.getPlayerIdByUserId(params.userId, trx)),
      actorId: params.actorId,
      status: params.status,
      previousStatus:
        params.playerTransition?.previousStatus ?? params.previousStatus ?? 'not_started',
      reason: params.reason,
      source: params.source,
      tier: params.tier,
      ...(params.auditRecorded ? { auditRecorded: true } : {}),
    });
  }

  async submit(userId: User['id'], input: SubmitKycInput, meta?: ClientMeta) {
    const outcome = await this.drizzle.db.transaction((trx) =>
      withAdvisoryXactLock(trx, `kyc-submit:${userId}:${input.tier}`, async () => {
        const previous = await this.latestVerification(userId, input.tier, trx);

        if (previous && KYC_IN_PROGRESS_STATUSES.has(previous.status)) {
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
        const dob = this.readVendorDateOfBirth(result.referenceId, result.dateOfBirth);
        const gated = gateVendorDecision(result.status, result.checks, dob);
        const status = gated.status;
        const decisionReason = gated.reason ?? null;
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
        await this.emitUpdated(trx, {
          userId,
          tier: input.tier,
          status,
          previousStatus: previous?.status ?? null,
          playerTransition,
          actorId: null,
          reason: decisionReason,
          source: 'vendor',
        });
        const playerId =
          playerTransition?.playerId ??
          (await this.identityReader.getPlayerIdByUserId(userId, trx));
        await this.events.emitInTransaction(trx, 'compliance.kyc.submitted', {
          userId,
          playerId,
          referenceId: result.referenceId,
          provider: this.provider,
          tier: input.tier,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        });
        await this.emitDateOfBirthSignal(trx, dob, {
          userId,
          playerId,
          referenceId: result.referenceId,
          tier: input.tier,
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

    return { ...toDto(outcome.row), verificationUrl: outcome.verificationUrl };
  }

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
      dateOfBirth?: string;
    } = {},
  ) {
    const dob = this.readVendorDateOfBirth(referenceId, opts.dateOfBirth);
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
        const persistedChecks = opts.checks ?? row.checks ?? undefined;
        const gated = gateVendorDecision(vendorStatus, persistedChecks, dob);
        const status = gated.status;
        const reasonFromThisReconcile = gated.reason ?? opts.reason;
        const decisionReason = reasonFromThisReconcile ?? row.decisionReason;

        const heldUnderage = row.status === 'rejected' && row.decisionReason === UNDERAGE_REASON;
        if (
          heldUnderage ||
          (row.status === status &&
            row.decidedAt &&
            (!dob.underage || row.decisionReason === UNDERAGE_REASON))
        ) {
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
        await this.emitUpdated(trx, {
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

      const anyChanged = reconciled.some((outcome) => outcome.changed);
      const [primaryOutcome] = reconciled;
      const highRisk = opts.riskSignals && warrantsHighRiskTag(opts.riskSignals);
      if (!primaryOutcome || !anyChanged || (dob.dateOfBirth === undefined && !highRisk)) {
        return reconciled;
      }
      const signal = {
        userId: ownerUserId,
        playerId: await this.identityReader.getPlayerIdByUserId(ownerUserId, trx),
        referenceId,
        tier: primaryOutcome.row.tier,
      };
      await this.emitDateOfBirthSignal(trx, dob, signal);
      if (opts.riskSignals && highRisk) {
        await this.events.emitInTransaction(trx, 'compliance.kyc.high_risk_signal_detected', {
          ...signal,
          vpnOrTorDetected: opts.riskSignals.vpnOrTorDetected,
          dataCenterIpDetected: opts.riskSignals.dataCenterIpDetected,
          duplicateDeviceDetected: opts.riskSignals.duplicateDeviceDetected,
          highRiskCountryDetected: opts.riskSignals.highRiskCountryDetected,
        });
      }

      return reconciled;
    });

    if (outcomes.length === 0) {
      return null;
    }

    const primary = outcomes.find((outcome) => outcome.changed) ?? outcomes[0];
    return primary ? toDto(primary.row) : null;
  }

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
      dateOfBirth: decision.dateOfBirth,
    });
  }

  private readVendorDateOfBirth(referenceId: string, raw: string | undefined): VendorDateOfBirth {
    if (raw === undefined) {
      return { underage: false, unreadable: false };
    }
    const parsed = VendorDateOfBirthSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ referenceId }, 'KYC vendor date of birth is not an ISO date');
      return { underage: false, unreadable: true };
    }
    return {
      dateOfBirth: parsed.data,
      underage: !isAdultDateOfBirth(
        parsed.data,
        new Date(),
        resolveMinPlayerAge(this.platformConfig),
      ),
      unreadable: false,
    };
  }

  private async emitDateOfBirthSignal(
    trx: DrizzleTx,
    dob: VendorDateOfBirth,
    signal: { userId: User['id']; playerId: string | null; referenceId: string; tier: KycTier },
  ) {
    if (dob.underage) {
      await this.events.emitInTransaction(trx, 'compliance.kyc.underage_detected', signal);
      return;
    }
    if (
      dob.dateOfBirth !== undefined &&
      (await this.declaredDateOfBirthDiffers(signal.userId, dob.dateOfBirth, trx))
    ) {
      await this.events.emitInTransaction(trx, 'compliance.kyc.dob_mismatch_detected', signal);
    }
  }

  private async declaredDateOfBirthDiffers(
    userId: User['id'],
    verified: string,
    trx: DrizzleTx,
  ): Promise<boolean> {
    if (!this.identityReader.getPlayerDateOfBirthByUserId) {
      return false;
    }
    const declared = await this.identityReader.getPlayerDateOfBirthByUserId(userId, trx);
    return declared !== verified;
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

  async getKycStanding(userId: User['id']) {
    const [kycStatus, view] = await Promise.all([
      this.identityReader.getPlayerKycStatusByUserId(userId),
      this.getForPlayer(userId),
    ]);
    if (!kycStatus) {
      return null;
    }
    return {
      kycStatus: normalizeKycStatus(kycStatus),
      basic: view.basic.current ? toStandingVerification(view.basic.current) : null,
      advanced: view.advanced.current ? toStandingVerification(view.advanced.current) : null,
      basicDecisionReason: view.basic.current?.decisionReason ?? null,
      advancedDecisionReason: view.advanced.current?.decisionReason ?? null,
    };
  }

  private async unpricedCurrencies(
    rows: readonly { currency: string; total: string }[],
    pivotCurrency: string,
  ): Promise<string[]> {
    const others = rows.filter((row) => row.currency.toUpperCase() !== pivotCurrency.toUpperCase());
    const checked = await mapConcurrent(others, 5, async (row) => ({
      currency: row.currency,
      priced: this.exchangeRateReader
        ? (await this.exchangeRateReader.convert(row.total, row.currency, pivotCurrency)) !== null
        : false,
    }));
    return checked.filter((row) => !row.priced).map((row) => row.currency);
  }

  async handleDeposit(userId: User['id']) {
    const [current] = await this.drizzle.db
      .select({ id: player.id, currency: player.currency, kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId));
    if (!current || normalizeKycStatus(current.kycStatus) !== 'approved') {
      return;
    }

    const depositsByCurrency = await this.walletReader.getDepositsByCurrency(userId);
    const pivotCurrency = resolveExchangeRatePivot(this.platformConfig?.exchangeRate);
    const totalDeposits = await sumInPivot(
      depositsByCurrency,
      pivotCurrency,
      this.exchangeRateReader,
    );
    if (totalDeposits === null) {
      const unpriced = await this.unpricedCurrencies(depositsByCurrency, pivotCurrency);
      const err = new Error(
        `handleDeposit: no rate for ${unpriced.join(', ')} into ${pivotCurrency}`,
      );
      logger.error(
        { err, userId, unpriced, pivotCurrency },
        'handleDeposit: could not price a deposit currency, skipping re-KYC evaluation',
      );
      reportError(err, { userId, extra: { unpriced, pivotCurrency } });
      return;
    }

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

    const snapshot = {
      totalDeposits,
      currency: pivotCurrency,
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
      await this.emitUpdated(trx, {
        userId,
        tier: 'basic',
        status: 'resubmission_requested',
        previousStatus: current.kycStatus,
        playerTransition,
        actorId: null,
        reason,
        source: 'reverify',
      });
      await this.events.emitInTransaction(trx, 'compliance.kyc.reverify_required', {
        userId,
        playerId: current.id,
        reason,
        tier: 'basic',
      });
    });
  }

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

  async requestResubmission(
    userId: User['id'],
    tier: KycTier,
    reason: string,
    actorId: User['id'],
  ) {
    const outcome = await this.lockedResubmissionRequest({ userId, tier, reason, actorId });
    if (!outcome.row) {
      throw new KycVerificationNotFoundError(userId);
    }
    return outcome.row;
  }

  async assertEnhancedKycRequestable(userId: User['id']) {
    const latest = await this.latestVerification(userId, 'advanced');
    if (latest?.status === 'resubmission_requested') {
      throw new KycResubmissionAlreadyRequestedError();
    }
    if (latest && KYC_IN_PROGRESS_STATUSES.has(latest.status)) {
      throw new KycVerificationInProgressError();
    }
  }

  async requestEnhancedKyc({
    userId,
    reason,
    actorId,
  }: {
    userId: User['id'];
    reason: string;
    actorId: User['id'];
  }) {
    const { changed } = await this.lockedResubmissionRequest({
      userId,
      tier: 'advanced',
      reason,
      actorId,
    });
    return { changed };
  }

  private lockedResubmissionRequest(params: {
    userId: User['id'];
    tier: KycTier;
    reason: string;
    actorId: User['id'];
  }) {
    return this.drizzle.db.transaction((trx) =>
      withAdvisoryXactLock(trx, `kyc-submit:${params.userId}:${params.tier}`, () =>
        this.applyResubmissionRequest(trx, params),
      ),
    );
  }

  private async applyResubmissionRequest(
    trx: DrizzleTx,
    {
      userId,
      tier,
      reason,
      actorId,
    }: {
      userId: User['id'];
      tier: KycTier;
      reason: string;
      actorId: User['id'];
    },
  ) {
    const current = await this.requirePlayerRowForUpdate(userId, trx);
    const latest = await this.latestVerification(userId, tier, trx);
    const currentStatus = tier === 'basic' ? current.kycStatus : latest?.status;
    if (currentStatus === 'resubmission_requested') {
      return { row: latest ? toDto(latest) : null, changed: false };
    }
    if (latest && KYC_IN_PROGRESS_STATUSES.has(latest.status)) {
      throw new KycVerificationInProgressError();
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
    await this.emitUpdated(trx, {
      userId,
      tier,
      status: 'resubmission_requested',
      previousStatus: currentStatus ?? null,
      playerTransition: applied.playerTransition,
      actorId,
      reason,
      source: 'manual',
    });
    return { row: applied.row, changed: true };
  }

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
      await this.emitUpdated(trx, {
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
        logger.error({ err, userId }, 'bulk KYC approve failed for player');
        return { userId, success: false, error: 'Failed to approve KYC' };
      }
    });
  }

  async applyExemption(
    userId: User['id'],
    params: { countryCode: string | null; reason: 'global_disabled' | 'country_exempt' },
  ): Promise<void> {
    await this.drizzle.db.transaction((trx) =>
      withAdvisoryXactLock(trx, `kyc-submit:${userId}:basic`, async () => {
        const current = await this.requirePlayerRowForUpdate(userId, trx);
        const existing = await this.latestVerification(userId, 'basic', trx);
        if (existing) {
          return;
        }

        const decisionReason =
          params.reason === 'global_disabled'
            ? 'KYC is globally disabled'
            : `Country ${params.countryCode ?? 'unknown'} is exempt from KYC`;
        findOneOrThrow(
          await trx
            .insert(kycVerification)
            .values({
              userId,
              provider: 'exemption',
              referenceId: `exemption-${params.countryCode ?? 'global'}`,
              tier: 'basic',
              status: 'approved',
              documentTypes: [],
              triggeredBy: 'exemption',
              decisionReason,
              decidedAt: new Date(),
            })
            .returning(),
          new KycVerificationNotFoundError(userId),
        );
        const playerTransition = await this.statusWriter.setStatus(
          userId,
          'approved',
          { actorId: null, source: 'exemption' },
          trx,
        );
        await this.audit.recordInTransaction(trx, {
          actorType: 'system',
          action: 'compliance.kyc.updated',
          resourceType: 'player',
          resourceId: playerTransition?.playerId ?? current.id,
          before: { kycStatus: current.kycStatus, tier: 'basic' },
          after: {
            kycStatus: 'approved',
            tier: 'basic',
            reason: decisionReason,
            source: 'exemption',
          },
        });
        await this.emitUpdated(trx, {
          userId,
          playerId: playerTransition?.playerId ?? current.id,
          tier: 'basic',
          status: 'approved',
          previousStatus: current.kycStatus,
          playerTransition,
          actorId: null,
          reason: decisionReason,
          source: 'exemption',
          auditRecorded: true,
        });
      }),
    );
  }

  private async requirePlayerRowForUpdate(userId: User['id'], tx: DrizzleTx) {
    const rows = await tx
      .select({ id: player.id, kycStatus: player.kycStatus })
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
