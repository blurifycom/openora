import {
  DrizzleService,
  assertOwnership,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  moneySubtract,
  moneyToNumber,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type {
  ClientMeta,
  IdentityReader,
  LimitPeriod,
  LimitType,
  ResponsibleGamingConfig,
  User,
} from '@openora/core/contracts';
import { userLimit } from '../schema/index.js';
import { LimitNotFoundError, LimitOwnershipError } from './compliance.service.js';
import { NO_PENDING_CHANGE, RgService } from './rg.service.js';
import { RgMonitoringService } from './rg-monitoring.service.js';
import { periodWindow, pendingChangeStatus, thresholdPct } from './rg-eval.js';
import type {
  LimitView,
  RgExclusion,
  RgSection,
  RequestCoolingOffInput,
  RequestSelfExclusionInput,
  UpsertLimitInput,
} from '../contract/index.js';

const HOUR_MS = 60 * 60 * 1000;

// The admin schema requires a non-empty reason and the audit trail wants one; a player
// clicking a self-service button supplies none, so the reason IS that fact.
const SELF_SERVICE_REASON = 'Player self-service request';

export const NoPendingLimitChangeError = makeNotFoundError('PendingLimitChange');
export const CooldownNotElapsedError = makeConflictError(
  'CooldownNotElapsedError',
  'The cool-down on this limit change has not elapsed yet',
);
export const LimitChangeExpiredError = makeConflictError(
  'LimitChangeExpiredError',
  'This limit change was not confirmed in time and has lapsed',
);

type LimitRow = typeof userLimit.$inferSelect;

// A raise and a removal both weaken the protection; a first limit and a lower one do
// not. Only the weakening direction serves the cool-down.
function isWeakening(row: LimitRow, next: Pick<UpsertLimitInput, 'amount' | 'minutes'>): boolean {
  if (next.amount !== null && row.amount !== null) {
    return moneyCompare(next.amount, row.amount) > 0;
  }
  if (next.minutes !== null && row.minutes !== null) {
    return next.minutes > row.minutes;
  }
  // A limit that changes measure (money <-> minutes) cannot happen: `type` fixes which
  // one applies and `type` is part of the row's identity. Treat the impossible case as
  // weakening rather than waving it through.
  return true;
}

export type RgSelfServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  rg: RgService;
  monitoring: RgMonitoringService;
  identityReader: IdentityReader;
  config: ResponsibleGamingConfig;
};

/**
 * Player self-service responsible-gambling: setting, lowering, raising, dropping and
 * confirming limits, plus starting a break or a self-exclusion on oneself.
 *
 * The one invariant everything here exists to protect: **a limit never moves upward
 * without the player confirming it after the cool-down**. `user_limit.amount` is
 * therefore the effective limit at all times - nothing is promoted lazily on read, and
 * the expiry sweep only ever CLEARS a request, never applies one. A request is parked in
 * the `pending*` columns and stays inert until `confirmPendingChange` runs.
 *
 * Lowering a limit, and cancelling a request, are always immediate: moving back toward
 * more protection never needs to be slowed down.
 */
export class RgSelfServiceService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly rg: RgService;
  private readonly monitoring: RgMonitoringService;
  private readonly identityReader: IdentityReader;
  private readonly config: ResponsibleGamingConfig;

  constructor(deps: RgSelfServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.rg = deps.rg;
    this.monitoring = deps.monitoring;
    this.identityReader = deps.identityReader;
    this.config = deps.config;
  }

  /** Limits with their usage and any pending request, plus the exclusions in force. */
  async getSection(userId: User['id']): Promise<RgSection> {
    const [rows, exclusions] = await Promise.all([
      this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId)),
      this.rg.getActiveExclusions(userId),
    ]);
    return { limits: await this.toViews(userId, rows), ...exclusions };
  }

  async getLimits(userId: User['id']): Promise<LimitView[]> {
    const rows = await this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    return this.toViews(userId, rows);
  }

  /**
   * A first limit or a lower one is written immediately; a raise files a request that
   * serves the cool-down. Either way the returned view's `amount` is the limit in force
   * right now, which for a raise is still the OLD value.
   */
  async upsertLimit(
    userId: User['id'],
    input: UpsertLimitInput,
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const [existing] = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(
        and(
          eq(userLimit.userId, userId),
          eq(userLimit.type, input.type),
          eq(userLimit.period, input.period),
        ),
      )
      .limit(1);

    if (!existing || !isWeakening(existing, input)) {
      // setPlayerLimit also voids any request parked on this limit (and says so on the
      // event bus) - a directly written limit is the current decision.
      await this.rg.setPlayerLimit(userId, { ...input, userId }, userId, 'player', meta);
      return this.viewOne(userId, input.type, input.period);
    }

    return this.fileRequest(userId, existing, 'increase', input, meta);
  }

  /**
   * Files a REMOVAL request. The row stays and the limit keeps applying until the player
   * confirms - dropping a limit is exactly the change the cool-down exists for.
   */
  async requestLimitRemoval(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const existing = await this.ownedLimit(limitId, userId);
    return this.fileRequest(userId, existing, 'removal', { amount: null, minutes: null }, meta);
  }

  /**
   * Applies a request whose cool-down has elapsed - the ONLY path that raises a limit or
   * deletes one. Returns null when the confirmed request was a removal (the limit is
   * gone); the limit's new state otherwise.
   */
  async confirmPendingChange(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView | null> {
    const existing = await this.ownedLimit(limitId, userId);
    const now = new Date();
    const status = pendingChangeStatus(existing, now);

    if (status === null) {
      throw new NoPendingLimitChangeError(limitId);
    }
    if (status === 'waiting') {
      throw new CooldownNotElapsedError();
    }
    if (status === 'expired') {
      // The sweep had not got to it yet. Clear it here so the player's next attempt
      // starts from a clean row rather than hitting the same wall again.
      await this.clearPending(existing, 'rg.limit.change_expired', null, meta);
      throw new LimitChangeExpiredError();
    }

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    const base = {
      userId,
      playerId,
      actorId: userId,
      limitId: existing.id,
      type: existing.type,
      period: existing.period,
      kind: existing.pendingKind as 'increase' | 'removal',
      previousAmount: existing.amount,
      previousMinutes: existing.minutes,
      requestedAmount: existing.pendingAmount,
      requestedMinutes: existing.pendingMinutes,
      initiatedBy: 'player' as const,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    };

    if (existing.pendingKind === 'removal') {
      await this.drizzle.db.delete(userLimit).where(eq(userLimit.id, existing.id));
      // Nothing left to breach, so the 80% flag this limit raised has to go with it -
      // `evaluateUser` only walks limits that still exist and would leave it standing.
      await this.monitoring.clearLimitThresholdFlag(userId, existing.type);
      this.events.emit('rg.limit.change_confirmed', base);
      return null;
    }

    // The single write that moves a limit upward: the new amount and the clearing of the
    // request that authorised it land together, so a retry cannot apply it twice.
    const row = findOneOrThrow(
      await this.drizzle.db
        .update(userLimit)
        .set({
          amount: existing.pendingAmount,
          minutes: existing.pendingMinutes,
          ...NO_PENDING_CHANGE,
        })
        .where(and(eq(userLimit.id, existing.id), isNotNull(userLimit.pendingKind)))
        .returning(),
      new NoPendingLimitChangeError(limitId),
    );
    this.events.emit('rg.limit.change_confirmed', base);
    // Also the plain "the limit is now X" fact: it is what re-runs the 80% evaluation and
    // what the admin RG history renders, and it must not depend on knowing this module's
    // request state machine.
    this.events.emit('rg.limit.set', {
      userId,
      playerId,
      actorId: userId,
      limitId: row.id,
      type: row.type,
      period: row.period,
      amount: row.amount,
      minutes: row.minutes,
      previousAmount: existing.amount,
      previousMinutes: existing.minutes,
      initiatedBy: 'player',
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.rg.notifyLimitUpdated(userId, row.type, row.period, row.amount, row.minutes);
    return this.toView(userId, row);
  }

  /** Withdrawing a request restores the stricter state, so it never waits on anything. */
  async cancelPendingChange(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const existing = await this.ownedLimit(limitId, userId);
    if (existing.pendingKind === null) {
      // Idempotent: cancelling nothing has already achieved what the caller wanted.
      return this.toView(userId, existing);
    }
    await this.clearPending(existing, 'rg.limit.change_cancelled', userId, meta);
    return this.toView(userId, { ...existing, ...NO_PENDING_CHANGE });
  }

  /**
   * A short break the player starts on themselves. Goes through `RgService` so it gets
   * the same session kill, login block and mail as an admin-activated one.
   */
  requestCoolingOff(
    userId: User['id'],
    input: RequestCoolingOffInput,
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    return this.rg.activateCoolingOff(
      userId,
      { userId, durationHours: input.durationHours, reason: SELF_SERVICE_REASON },
      userId,
      'player',
      meta,
    );
  }

  /**
   * Self-exclusion the player starts on themselves. Irreversible before its term - the
   * platform refuses to lift a permanent one at all, and a fixed-term one before it has
   * elapsed, for a player and an admin alike (see `RgService.liftSelfExclusion`).
   */
  requestSelfExclusion(
    userId: User['id'],
    input: RequestSelfExclusionInput,
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    return this.rg.activateSelfExclusion(
      userId,
      {
        userId,
        isPermanent: input.isPermanent,
        ...(input.durationMonths === undefined ? {} : { durationMonths: input.durationMonths }),
        reason: SELF_SERVICE_REASON,
        confirm: true,
      },
      userId,
      'player',
      meta,
    );
  }

  /**
   * Background hygiene: drop requests nobody confirmed in time. This never touches
   * `amount` - that is the whole guarantee that a limit cannot rise on a timer. Runs in
   * the rg-monitor sweep beside `expireLapsedCoolingOffs`.
   */
  async expireStaleLimitChanges(): Promise<void> {
    const now = new Date();
    const candidates = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(and(isNotNull(userLimit.pendingKind), lte(userLimit.pendingExpiresAt, now)));
    if (candidates.length === 0) {
      return;
    }
    // Re-assert the deadline in the UPDATE: a request confirmed and re-filed between the
    // read and the write carries a future deadline and must survive this sweep.
    const cleared = await this.drizzle.db
      .update(userLimit)
      .set(NO_PENDING_CHANGE)
      .where(
        and(
          inArray(
            userLimit.id,
            candidates.map((c) => c.id),
          ),
          isNotNull(userLimit.pendingKind),
          lte(userLimit.pendingExpiresAt, now),
        ),
      )
      .returning({ id: userLimit.id });
    const clearedIds = new Set(cleared.map((r) => r.id));
    const playerIds = await this.identityReader.getPlayerIdsByUserIdsSafe(
      candidates.map((c) => c.userId),
    );
    for (const row of candidates) {
      if (!clearedIds.has(row.id)) {
        continue;
      }
      this.events.emit('rg.limit.change_expired', {
        userId: row.userId,
        playerId: playerIds.get(row.userId) ?? null,
        limitId: row.id,
        type: row.type,
        period: row.period,
        kind: row.pendingKind as 'increase' | 'removal',
        previousAmount: row.amount,
        previousMinutes: row.minutes,
        requestedAmount: row.pendingAmount,
        requestedMinutes: row.pendingMinutes,
        expiresAt: (row.pendingExpiresAt ?? now).toISOString(),
      });
    }
  }

  private async fileRequest(
    userId: User['id'],
    existing: LimitRow,
    kind: 'increase' | 'removal',
    target: { amount: string | null; minutes: number | null },
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const now = new Date();
    const effectiveAt = new Date(now.getTime() + this.config.limitIncreaseCooldownHours * HOUR_MS);
    const expiresAt = new Date(
      effectiveAt.getTime() + this.config.limitChangeConfirmationWindowHours * HOUR_MS,
    );
    // A new request REPLACES whatever was parked and restarts the clock. Inheriting the
    // old deadline would let a player file, wait, then swap in a bigger number and
    // confirm it immediately.
    const row = findOneOrThrow(
      await this.drizzle.db
        .update(userLimit)
        .set({
          pendingKind: kind,
          pendingAmount: target.amount,
          pendingMinutes: target.minutes,
          pendingRequestedAt: now,
          pendingEffectiveAt: effectiveAt,
          pendingExpiresAt: expiresAt,
        })
        .where(eq(userLimit.id, existing.id))
        .returning(),
      new LimitNotFoundError(existing.id),
    );
    this.events.emit('rg.limit.change_requested', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId: userId,
      limitId: row.id,
      type: row.type,
      period: row.period,
      kind,
      previousAmount: existing.amount,
      previousMinutes: existing.minutes,
      requestedAmount: target.amount,
      requestedMinutes: target.minutes,
      effectiveAt: effectiveAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      initiatedBy: 'player',
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return this.toView(userId, row);
  }

  private async clearPending(
    row: LimitRow,
    topic: 'rg.limit.change_cancelled' | 'rg.limit.change_expired',
    actorId: User['id'] | null,
    meta?: ClientMeta,
  ): Promise<void> {
    const cleared = await this.drizzle.db
      .update(userLimit)
      .set(NO_PENDING_CHANGE)
      .where(and(eq(userLimit.id, row.id), isNotNull(userLimit.pendingKind)))
      .returning({ id: userLimit.id });
    if (cleared.length === 0) {
      // Someone else cleared it first; emitting a second event for one request would
      // put a duplicate in the regulatory export.
      return;
    }
    const common = {
      userId: row.userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(row.userId),
      limitId: row.id,
      type: row.type,
      period: row.period,
      kind: row.pendingKind as 'increase' | 'removal',
      previousAmount: row.amount,
      previousMinutes: row.minutes,
      requestedAmount: row.pendingAmount,
      requestedMinutes: row.pendingMinutes,
    };
    if (topic === 'rg.limit.change_expired') {
      this.events.emit(topic, {
        ...common,
        expiresAt: (row.pendingExpiresAt ?? new Date()).toISOString(),
      });
      return;
    }
    this.events.emit(topic, {
      ...common,
      actorId: actorId ?? row.userId,
      initiatedBy: 'player',
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  }

  private async ownedLimit(limitId: LimitRow['id'], userId: User['id']): Promise<LimitRow> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(userLimit).where(eq(userLimit.id, limitId)),
      new LimitNotFoundError(limitId),
    );
    assertOwnership(existing.userId, userId, new LimitOwnershipError());
    return existing;
  }

  private async viewOne(
    userId: User['id'],
    type: UpsertLimitInput['type'],
    period: UpsertLimitInput['period'],
  ): Promise<LimitView> {
    const row = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(userLimit)
        .where(
          and(eq(userLimit.userId, userId), eq(userLimit.type, type), eq(userLimit.period, period)),
        ),
      new LimitNotFoundError(userId),
    );
    return this.toView(userId, row);
  }

  private async toViews(userId: User['id'], rows: LimitRow[]): Promise<LimitView[]> {
    const views: LimitView[] = [];
    // Sequential rather than a fan-out: a player has a handful of limits, and each view
    // costs one aggregate query (see no-unbounded-db-fanout).
    for (const row of rows) {
      views.push(await this.toView(userId, row));
    }
    return views;
  }

  private async toView(userId: User['id'], row: LimitRow): Promise<LimitView> {
    const now = new Date();
    const status = pendingChangeStatus(row, now);
    const base = serializeRow(row, {
      dateFields: ['createdAt', 'pendingEffectiveAt', 'pendingExpiresAt'],
    });
    // Money-type limits only: the session-time limit is measured in minutes by the
    // session sweep, and has no money spend to report here.
    const isMoneyLimit = row.amount !== null && row.period !== 'session';
    const used = isMoneyLimit
      ? await this.monitoring.spendFor(
          userId,
          row.type as LimitType,
          periodWindow(row.period as LimitPeriod, now).from,
        )
      : null;
    const limit = row.amount;
    return {
      id: base.id,
      userId: base.userId,
      type: base.type,
      amount: base.amount,
      minutes: base.minutes,
      period: base.period,
      createdAt: base.createdAt,
      used,
      remaining:
        used !== null && limit !== null
          ? moneyCompare(used, limit) >= 0
            ? '0'
            : moneySubtract(limit, used)
          : null,
      pct:
        used !== null && limit !== null
          ? thresholdPct(moneyToNumber(used), moneyToNumber(limit))
          : null,
      // An expired-but-unswept request reads as no request at all - every pending field
      // goes null together, so a client never has to know that state exists and can
      // never render a Confirm button for a request the API would refuse.
      ...(status === 'waiting' || status === 'ready'
        ? {
            pendingKind: row.pendingKind,
            pendingAmount: base.pendingAmount,
            pendingMinutes: row.pendingMinutes,
            pendingStatus: status,
            pendingEffectiveAt: base.pendingEffectiveAt,
            pendingExpiresAt: base.pendingExpiresAt,
          }
        : {
            pendingKind: null,
            pendingAmount: null,
            pendingMinutes: null,
            pendingStatus: null,
            pendingEffectiveAt: null,
            pendingExpiresAt: null,
          }),
    };
  }
}
