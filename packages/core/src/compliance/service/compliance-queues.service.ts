import { and, asc, count, desc, eq, gte, inArray, sql } from '@openora/core/server/orm';
import type { DrizzleService } from '@openora/core/server';
import {
  KycTierSchema,
  LimitTypeSchema,
  type KycStatus,
  type KycTier,
  type LimitType,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import {
  KYC_QUEUE_STATUSES,
  KycDocumentTypeSchema,
  KycQueueStatusSchema,
  type KycQueue,
  type KycQueueInput,
  type RgFlagsQueue,
  type RgFlagsQueueInput,
} from '../contract/index.js';
import { kycVerification, rgFlag } from '../schema/index.js';

const HOUR_MS = 60 * 60 * 1000;
const RECENT_FLAG_DAYS = 7;

/** Hours from `from` to `now`, to one decimal, never negative. */
const hoursBetween = (from: Date, now: Date) =>
  Math.round(Math.max(0, (now.getTime() - from.getTime()) / HOUR_MS) * 10) / 10;

/** A flag's limit as it was stored, kept only when it is a limit type compliance knows. */
const limitTypeOf = (value: string | null): LimitType | null =>
  LimitTypeSchema.safeParse(value).data ?? null;

/**
 * The compliance queues an agent reads across all players: the open responsible-gambling flags
 * and the KYC verifications waiting. Each names a player by player id only, and returns no
 * reason, note, document or personal data.
 */
export class ComplianceQueuesService {
  constructor(private readonly drizzle: DrizzleService) {}

  async rgFlagsQueue(
    { flagType, limit }: RgFlagsQueueInput,
    now: Date = new Date(),
  ): Promise<RgFlagsQueue> {
    const db = this.drizzle.db;
    const since = new Date(now.getTime() - RECENT_FLAG_DAYS * 24 * HOUR_MS);
    const [byType, recent, oldest] = await Promise.all([
      db
        .select({ flagType: rgFlag.flagType, count: count() })
        .from(rgFlag)
        .where(eq(rgFlag.status, 'active'))
        .groupBy(rgFlag.flagType)
        .orderBy(desc(count()), asc(rgFlag.flagType)),
      db.select({ count: count() }).from(rgFlag).where(gte(rgFlag.flaggedAt, since)),
      db
        .select({
          flagId: rgFlag.id,
          playerId: player.id,
          flagType: rgFlag.flagType,
          limitType: rgFlag.limitType,
          flaggedAt: rgFlag.flaggedAt,
        })
        .from(rgFlag)
        .leftJoin(player, eq(player.userId, rgFlag.userId))
        .where(
          and(eq(rgFlag.status, 'active'), flagType ? eq(rgFlag.flagType, flagType) : undefined),
        )
        .orderBy(asc(rgFlag.flaggedAt), asc(rgFlag.id))
        .limit(limit),
    ]);
    return {
      activeCount: byType.reduce((sum, row) => sum + row.count, 0),
      activeByType: byType,
      flaggedLast7Days: recent[0]?.count ?? 0,
      oldest: oldest.map((row) => ({
        flagId: row.flagId,
        playerId: row.playerId,
        flagType: row.flagType,
        limitType: limitTypeOf(row.limitType),
        flaggedAt: row.flaggedAt.toISOString(),
        waitHours: hoursBetween(row.flaggedAt, now),
      })),
    };
  }

  /**
   * Counts each player's latest verification per tier: an older one a later attempt superseded
   * waits for nothing.
   */
  async kycQueue(
    { tier, status, limit }: KycQueueInput,
    now: Date = new Date(),
  ): Promise<KycQueue> {
    const db = this.drizzle.db;
    const latest = db
      .selectDistinctOn([kycVerification.userId, kycVerification.tier], {
        id: kycVerification.id,
        userId: kycVerification.userId,
        tier: kycVerification.tier,
        status: kycVerification.status,
        triggeredBy: kycVerification.triggeredBy,
        documentTypes: kycVerification.documentTypes,
        submittedAt: kycVerification.submittedAt,
      })
      .from(kycVerification)
      .orderBy(kycVerification.userId, kycVerification.tier, desc(kycVerification.createdAt))
      .as('latest');
    const waitHours = sql<
      number | null
    >`avg(extract(epoch from (${now.toISOString()}::timestamptz - ${latest.submittedAt})) / 3600)`.mapWith(
      (value: string | null) => (value === null ? null : Number(value)),
    );
    const [counts, oldest] = await Promise.all([
      db
        .select({ tier: latest.tier, status: latest.status, count: count(), waitHours })
        .from(latest)
        .where(inArray(latest.status, [...KYC_QUEUE_STATUSES]))
        .groupBy(latest.tier, latest.status),
      db
        .select({
          verificationId: latest.id,
          playerId: player.id,
          tier: latest.tier,
          status: latest.status,
          triggeredBy: latest.triggeredBy,
          documentTypes: latest.documentTypes,
          submittedAt: latest.submittedAt,
        })
        .from(latest)
        .leftJoin(player, eq(player.userId, latest.userId))
        .where(
          and(
            status ? eq(latest.status, status) : inArray(latest.status, [...KYC_QUEUE_STATUSES]),
            tier ? eq(latest.tier, tier) : undefined,
          ),
        )
        .orderBy(asc(latest.submittedAt), asc(latest.id))
        .limit(limit),
    ]);
    const countOf = (rowTier: KycTier, rowStatus: KycStatus) =>
      counts.find((row) => row.tier === rowTier && row.status === rowStatus)?.count ?? 0;
    const pending = counts.filter((row) => row.status === 'pending');
    const pendingCount = pending.reduce((sum, row) => sum + row.count, 0);
    const pendingWait = pending.reduce((sum, row) => sum + (row.waitHours ?? 0) * row.count, 0);
    return {
      pendingCount,
      resubmissionRequestedCount: counts
        .filter((row) => row.status === 'resubmission_requested')
        .reduce((sum, row) => sum + row.count, 0),
      byTier: KycTierSchema.options
        .map((rowTier) => ({
          tier: rowTier,
          pending: countOf(rowTier, 'pending'),
          resubmissionRequested: countOf(rowTier, 'resubmission_requested'),
        }))
        .filter((row) => row.pending + row.resubmissionRequested > 0),
      avgPendingWaitHours:
        pendingCount === 0 ? null : Math.round((pendingWait / pendingCount) * 10) / 10,
      oldest: oldest.map((row) => ({
        verificationId: row.verificationId,
        playerId: row.playerId,
        tier: row.tier,
        status: KycQueueStatusSchema.parse(row.status),
        triggeredBy: row.triggeredBy,
        documentTypes: row.documentTypes.filter(
          (type) => KycDocumentTypeSchema.safeParse(type).success,
        ),
        submittedAt: row.submittedAt.toISOString(),
        waitHours: hoursBetween(row.submittedAt, now),
      })),
    };
  }
}
