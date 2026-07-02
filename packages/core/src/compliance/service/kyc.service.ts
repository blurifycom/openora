import { DrizzleService, type EventBus } from '@blurifycom/core/server';
import type {
  KycAdapter,
  KycStatusWriter,
  KycVendorStatus,
  KycStatus,
  PlatformConfig,
} from '@blurifycom/core/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { kycVerification, type KycVerification } from '../schema/index.js';
// Cross-domain reads via public /schema subpaths (ADR-0020); the wallet ledger is the
// source of truth for lifetime deposits (player.totalDeposits is not maintained).
import { player } from '@blurifycom/core/pam/schema/profile';
import { wallet, walletTransaction } from '@blurifycom/core/wallet/schema';
import type {
  KycVerification as KycVerificationDto,
  SubmitKycInput,
  PlayerKycView,
} from '../schemas/index.js';
import { CumulativeDepositReKycTrigger, type ReKycTrigger } from './re-kyc-trigger.js';

const DEFAULT_PROVIDER = 'mock';

function mapVendorStatus(vendor: KycVendorStatus) {
  switch (vendor) {
    case 'approved':
      return 'verified';
    case 'rejected':
      return 'rejected';
    case 'pending':
      return 'pending';
    case 'not_started':
      return 'not_started';
  }
}

function isDecided(status: KycStatus) {
  return status === 'verified' || status === 'rejected';
}

function toDto(row: KycVerification): KycVerificationDto {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    referenceId: row.referenceId,
    status: row.status,
    documentTypes: row.documentTypes,
    decisionReason: row.decisionReason,
    triggeredBy: row.triggeredBy,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

  async submit(userId: string, input: SubmitKycInput) {
    const result = await this.kycAdapter.submit(
      userId,
      input.documents.map((d) => ({ type: d.type, frontUrl: d.frontUrl, backUrl: d.backUrl })),
    );
    const status = mapVendorStatus(result.status);
    const decided = isDecided(status);
    const [row] = await this.drizzle.db
      .insert(kycVerification)
      .values({
        userId,
        provider: this.provider,
        referenceId: result.referenceId,
        status,
        documentTypes: input.documents.map((d) => d.type),
        triggeredBy: 'submission',
        decidedAt: decided ? new Date() : null,
      })
      .returning();
    this.events.emit('compliance.kyc.submitted', {
      userId,
      referenceId: result.referenceId,
      provider: this.provider,
    });
    await this.statusWriter.setStatus(userId, status, { actorId: null, source: 'vendor' });
    return toDto(row!);
  }

  /**
   * Idempotent vendor-decision apply (polling + webhook). No-op when the latest record
   * already holds the mapped status.
   */
  async reconcile(referenceId: string, vendorStatus: KycVendorStatus, reason?: string) {
    const [existing] = await this.drizzle.db
      .select()
      .from(kycVerification)
      .where(eq(kycVerification.referenceId, referenceId))
      .orderBy(desc(kycVerification.createdAt))
      .limit(1);
    if (!existing) return null;

    const status = mapVendorStatus(vendorStatus);
    if (existing.status === status && existing.decidedAt) {
      return toDto(existing);
    }

    const [row] = await this.drizzle.db
      .update(kycVerification)
      .set({ status, decisionReason: reason ?? null, decidedAt: new Date() })
      .where(eq(kycVerification.id, existing.id))
      .returning();
    await this.statusWriter.setStatus(existing.userId, status, {
      actorId: null,
      source: 'webhook',
      reason,
    });
    return toDto(row!);
  }

  async getForPlayer(userId: string): Promise<PlayerKycView> {
    const rows = await this.drizzle.db
      .select()
      .from(kycVerification)
      .where(eq(kycVerification.userId, userId))
      .orderBy(desc(kycVerification.createdAt));
    return { current: rows[0] ? toDto(rows[0]) : null, history: rows.map(toDto) };
  }

  /**
   * Deposit-event hook: flips a currently-verified player to `resubmission_requested`
   * once cumulative deposits cross a fresh per-currency threshold band. Idempotent twice
   * over: skips unless presently `verified`, and the watermark stops a re-verified
   * high-roller re-firing on every later deposit.
   */
  async handleDeposit(userId: string) {
    const [current] = await this.drizzle.db
      .select({ currency: player.currency, kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId));
    if (!current || current.kycStatus !== 'verified') return;

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

    const totalDeposits = Number(deposited?.total ?? 0);
    const snapshot = {
      totalDeposits,
      currency: current.currency,
      lastTriggeredDeposits: Number(lastFire?.triggerDeposits ?? 0),
    };
    const thresholds = this.platformConfig?.kyc?.reverifyThresholds;
    if (!this.reKycTrigger.requiresReverify(snapshot, thresholds)) return;

    const reason = `Cumulative deposits ${totalDeposits} ${snapshot.currency} crossed the re-KYC threshold`;
    await this.drizzle.db.insert(kycVerification).values({
      userId,
      provider: this.provider,
      referenceId: `reverify-${userId}-${Date.now()}`,
      status: 'resubmission_requested',
      documentTypes: [],
      triggeredBy: 'reverify_threshold',
      triggerDeposits: String(totalDeposits),
      decisionReason: reason,
    });
    await this.statusWriter.setStatus(userId, 'resubmission_requested', {
      actorId: null,
      source: 'reverify',
      reason,
    });
    this.events.emit('compliance.kyc.reverify_required', { userId, reason });
  }
}
