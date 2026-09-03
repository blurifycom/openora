import {
  DrizzleService,
  assertOwnership,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  moneyCeilToScale,
  moneyCompare,
  moneyFloorToScale,
  moneySubtract,
  moneyToNumber,
  serializeRow,
  withAdvisoryXactLock,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type {
  ClientMeta,
  ExchangeRateReader,
  IdentityReader,
  LimitPeriod,
  LimitType,
  RgLimitErrorReason,
  ResponsibleGamingConfig,
  User,
} from '@openora/core/contracts';
import { MONEY_SCALE } from '@openora/core/contracts';
import { userLimit } from '../schema/index.js';
import { LimitNotFoundError, LimitOwnershipError } from './compliance.service.js';
import {
  NO_PENDING_CHANGE,
  RgService,
  limitSlotKey,
  isWeakening,
  toDbCurrency,
  toWireCurrency,
  resolveLimitCurrency,
  resolveLimitCurrencyInTx,
  writeLimitRow,
  RgLimitCurrencyUnresolvedError,
  type LimitRow,
} from './rg.service.js';
import { RgMonitoringService, RgRateUnavailableError } from './rg-monitoring.service.js';
import { periodWindow, pendingChangeStatus, thresholdPct } from './rg-eval.js';
import type {
  LimitView,
  RgExclusion,
  RgSection,
  RequestCoolingOffInput,
  RequestSelfExclusionInput,
  UpsertLimitInput,
} from '../contract/index.js';

const logger = createLogger('compliance-rg-self-service');

const HOUR_MS = 60 * 60 * 1000;

const RG_LIMIT_MONEY_SCALE = MONEY_SCALE;

const SELF_SERVICE_REASON = 'Player self-service request';

export const NoPendingLimitChangeError = makeNotFoundError('PendingLimitChange');

export type RgLimitChangeErrorData = { reason: RgLimitErrorReason };

export class CooldownNotElapsedError extends Error {
  readonly data: RgLimitChangeErrorData = { reason: 'cooldown_not_elapsed' };

  constructor() {
    super('The cool-down on this limit change has not elapsed yet');
    this.name = 'CooldownNotElapsedError';
  }
}

export class LimitChangeExpiredError extends Error {
  readonly data: RgLimitChangeErrorData = { reason: 'limit_change_expired' };

  constructor() {
    super('This limit change was not confirmed in time and has lapsed');
    this.name = 'LimitChangeExpiredError';
  }
}

export type RgSelfServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  rg: RgService;
  monitoring: RgMonitoringService;
  identityReader: IdentityReader;
  config: ResponsibleGamingConfig;
  rates: ExchangeRateReader;
};

/**
 * Player self-service responsible-gambling: setting, lowering, raising, dropping and
 * confirming limits, plus starting a break or a self-exclusion on oneself.
 *
 * A limit never moves upward without the player confirming it after the cool-down.
 * `user_limit.amount` is the effective limit at all times; a raise or removal is parked
 * in the `pending*` columns until `confirmPendingChange` runs. Lowering a limit, and
 * cancelling a request, are always immediate.
 */
export class RgSelfServiceService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly rg: RgService;
  private readonly monitoring: RgMonitoringService;
  private readonly identityReader: IdentityReader;
  private readonly config: ResponsibleGamingConfig;
  private readonly rates: ExchangeRateReader;

  constructor(deps: RgSelfServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.rg = deps.rg;
    this.monitoring = deps.monitoring;
    this.identityReader = deps.identityReader;
    this.config = deps.config;
    this.rates = deps.rates;
  }

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
   * A first limit or a lower one is written immediately; a raise files a request instead.
   * The returned view's `amount` is the limit in force right now, which for a raise is
   * still the OLD value.
   */
  async upsertLimit(
    userId: User['id'],
    input: UpsertLimitInput,
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const outcome = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, limitSlotKey(userId, input.type, input.period), async () => {
        const [existing] = await tx
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

        if (existing) {
          const resolvedExisting = await resolveLimitCurrencyInTx(tx, existing);
          if (await isWeakening(resolvedExisting, input, this.rates)) {
            return {
              applied: false as const,
              existing,
              row: await this.park(tx, existing, 'increase', input),
            };
          }
        }
        const row = await writeLimitRow(tx, userId, existing, input);
        return { applied: true as const, existing: existing ?? null, row };
      }),
    );

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    if (!outcome.applied) {
      this.emitRequested(userId, playerId, outcome.existing, outcome.row, meta);
      return this.toView(userId, outcome.row);
    }
    if (outcome.existing?.pendingKind) {
      this.events.emit(
        'rg.limit.change_cancelled',
        this.actedPayload(userId, playerId, outcome.existing, meta),
      );
    }
    this.events.emit('rg.limit.set', {
      userId,
      playerId,
      actorId: userId,
      limitId: outcome.row.id,
      type: outcome.row.type,
      period: outcome.row.period,
      amount: outcome.row.amount,
      minutes: outcome.row.minutes,
      previousAmount: outcome.existing?.amount ?? null,
      previousMinutes: outcome.existing?.minutes ?? null,
      initiatedBy: 'player',
      reason: null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.rg.notifyLimitUpdated(
      userId,
      outcome.row.type,
      outcome.row.period,
      outcome.row.amount,
      outcome.row.minutes,
    );
    return this.toView(userId, outcome.row);
  }

  /** Files a removal request. The row stays and the limit keeps applying until the player confirms. */
  async requestLimitRemoval(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const target = await this.ownedLimit(limitId, userId);
    const { existing, row } = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, limitSlotKey(userId, target.type, target.period), async () => {
        const current = await this.reread(tx, limitId, userId);
        return {
          existing: current,
          row: await this.park(tx, current, 'removal', {
            amount: null,
            minutes: null,
            currency: null,
          }),
        };
      }),
    );
    this.emitRequested(
      userId,
      await this.identityReader.getPlayerIdByUserIdSafe(userId),
      existing,
      row,
      meta,
    );
    return this.toView(userId, row);
  }

  /**
   * Applies a request whose cool-down has elapsed. Returns null when the confirmed
   * request was a removal; the limit's new state otherwise.
   */
  async confirmPendingChange(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView | null> {
    const target = await this.ownedLimit(limitId, userId);

    const outcome = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, limitSlotKey(userId, target.type, target.period), async () => {
        const reread = await this.reread(tx, limitId, userId);
        const current = await resolveLimitCurrencyInTx(tx, reread);
        const now = new Date();
        const status = pendingChangeStatus(current, now);

        if (status === null) {
          throw new NoPendingLimitChangeError(limitId);
        }
        if (status === 'waiting') {
          throw new CooldownNotElapsedError();
        }
        if (status === 'expired') {
          await tx
            .update(userLimit)
            .set(NO_PENDING_CHANGE)
            .where(this.pinnedTo(current))
            .returning({ id: userLimit.id });
          return { kind: 'expired' as const, existing: current };
        }

        if (current.pendingKind === 'removal') {
          const deleted = await tx
            .delete(userLimit)
            .where(this.pinnedTo(current))
            .returning({ id: userLimit.id });
          if (deleted.length === 0) {
            throw new NoPendingLimitChangeError(limitId);
          }
          return { kind: 'removed' as const, existing: current };
        }

        const row = findOneOrThrow(
          await tx
            .update(userLimit)
            .set({
              amount: current.pendingAmount,
              minutes: current.pendingMinutes,
              currency: current.pendingCurrency ?? current.currency,
              ...NO_PENDING_CHANGE,
            })
            .where(this.pinnedTo(current))
            .returning(),
          new NoPendingLimitChangeError(limitId),
        );
        return { kind: 'raised' as const, existing: current, row };
      }),
    );

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);

    if (outcome.kind === 'expired') {
      this.events.emit(
        'rg.limit.change_expired',
        this.lapsedPayload(userId, playerId, outcome.existing),
      );
      throw new LimitChangeExpiredError();
    }

    this.events.emit(
      'rg.limit.change_confirmed',
      this.actedPayload(userId, playerId, outcome.existing, meta),
    );

    if (outcome.kind === 'removed') {
      await this.monitoring.clearLimitThresholdFlag(userId, outcome.existing.type);
      await this.monitoring.evaluateUser(userId, 'rg.limit.set');
      return null;
    }

    this.events.emit('rg.limit.set', {
      userId,
      playerId,
      actorId: userId,
      limitId: outcome.row.id,
      type: outcome.row.type,
      period: outcome.row.period,
      amount: outcome.row.amount,
      minutes: outcome.row.minutes,
      previousAmount: outcome.existing.amount,
      previousMinutes: outcome.existing.minutes,
      initiatedBy: 'player',
      reason: null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.rg.notifyLimitUpdated(
      userId,
      outcome.row.type,
      outcome.row.period,
      outcome.row.amount,
      outcome.row.minutes,
    );
    return this.toView(userId, outcome.row);
  }

  async cancelPendingChange(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView> {
    const target = await this.ownedLimit(limitId, userId);
    const outcome = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, limitSlotKey(userId, target.type, target.period), async () => {
        const current = await this.reread(tx, limitId, userId);
        if (current.pendingKind === null) {
          return { cleared: false as const, row: current };
        }
        const rows = await tx
          .update(userLimit)
          .set(NO_PENDING_CHANGE)
          .where(this.pinnedTo(current))
          .returning();
        return { cleared: rows.length > 0, existing: current, row: rows[0] ?? current };
      }),
    );
    if (outcome.cleared && outcome.existing) {
      this.events.emit(
        'rg.limit.change_cancelled',
        this.actedPayload(
          userId,
          await this.identityReader.getPlayerIdByUserIdSafe(userId),
          outcome.existing,
          meta,
        ),
      );
    }
    return this.toView(userId, outcome.row);
  }

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
   * Self-exclusion the player starts on themselves. Irreversible before its term: the
   * platform refuses to lift a permanent one at all, and a fixed-term one before it has
   * elapsed, for a player and an admin alike.
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

  /** Drops requests nobody confirmed in time. Never touches `amount`. */
  async expireStaleLimitChanges(): Promise<void> {
    const now = new Date();
    const candidates = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(and(isNotNull(userLimit.pendingKind), lte(userLimit.pendingExpiresAt, now)));
    if (candidates.length === 0) {
      return;
    }
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

  private async park(
    tx: DrizzleTx,
    existing: LimitRow,
    kind: 'increase' | 'removal',
    target: { amount: string | null; minutes: number | null; currency: string | null },
  ): Promise<LimitRow> {
    const now = new Date();
    const effectiveAt = new Date(now.getTime() + this.config.limitIncreaseCooldownHours * HOUR_MS);
    const expiresAt = new Date(
      effectiveAt.getTime() + this.config.limitChangeConfirmationWindowHours * HOUR_MS,
    );
    return findOneOrThrow(
      await tx
        .update(userLimit)
        .set({
          pendingKind: kind,
          pendingAmount: target.amount,
          pendingMinutes: target.minutes,
          pendingCurrency:
            target.currency === null
              ? null
              : toDbCurrency(existing.type as LimitType, target.currency),
          pendingRequestedAt: now,
          pendingEffectiveAt: effectiveAt,
          pendingExpiresAt: expiresAt,
        })
        .where(eq(userLimit.id, existing.id))
        .returning(),
      new LimitNotFoundError(existing.id),
    );
  }

  private pinnedTo(row: LimitRow) {
    return and(
      eq(userLimit.id, row.id),
      isNotNull(userLimit.pendingKind),
      row.pendingRequestedAt === null
        ? isNull(userLimit.pendingRequestedAt)
        : eq(userLimit.pendingRequestedAt, row.pendingRequestedAt),
    );
  }

  private async reread(
    tx: DrizzleTx,
    limitId: LimitRow['id'],
    userId: User['id'],
  ): Promise<LimitRow> {
    return findOneOrThrow(
      await tx
        .select()
        .from(userLimit)
        .where(and(eq(userLimit.id, limitId), eq(userLimit.userId, userId))),
      new LimitNotFoundError(limitId),
    );
  }

  private emitRequested(
    userId: User['id'],
    playerId: string | null,
    previous: LimitRow,
    row: LimitRow,
    meta?: ClientMeta,
  ): void {
    this.events.emit('rg.limit.change_requested', {
      userId,
      playerId,
      actorId: userId,
      limitId: row.id,
      type: row.type,
      period: row.period,
      kind: row.pendingKind as 'increase' | 'removal',
      previousAmount: previous.amount,
      previousMinutes: previous.minutes,
      requestedAmount: row.pendingAmount,
      requestedMinutes: row.pendingMinutes,
      effectiveAt: (row.pendingEffectiveAt ?? new Date()).toISOString(),
      expiresAt: (row.pendingExpiresAt ?? new Date()).toISOString(),
      initiatedBy: 'player',
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  }

  private endedPayload(userId: User['id'], playerId: string | null, row: LimitRow) {
    return {
      userId,
      playerId,
      limitId: row.id,
      type: row.type,
      period: row.period,
      kind: row.pendingKind as 'increase' | 'removal',
      previousAmount: row.amount,
      previousMinutes: row.minutes,
      requestedAmount: row.pendingAmount,
      requestedMinutes: row.pendingMinutes,
    };
  }

  private actedPayload(
    userId: User['id'],
    playerId: string | null,
    row: LimitRow,
    meta?: ClientMeta,
  ) {
    return {
      ...this.endedPayload(userId, playerId, row),
      actorId: userId,
      initiatedBy: 'player' as const,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    };
  }

  private lapsedPayload(userId: User['id'], playerId: string | null, row: LimitRow) {
    return {
      ...this.endedPayload(userId, playerId, row),
      expiresAt: (row.pendingExpiresAt ?? new Date()).toISOString(),
    };
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
    const isMoneyLimit = row.amount !== null && row.period !== 'session';
    let resolvedCurrency = row.currency;
    let used: string | null = null;
    if (isMoneyLimit) {
      try {
        const resolved = await resolveLimitCurrency(this.drizzle, row);
        resolvedCurrency = resolved.currency;
        used = await this.monitoring.spendFor(
          this.drizzle.db,
          userId,
          row.type as LimitType,
          row.period as LimitPeriod,
          periodWindow(row.period as LimitPeriod, now).from,
          resolved.currency,
        );
      } catch (err) {
        if (
          !(err instanceof RgRateUnavailableError) &&
          !(err instanceof RgLimitCurrencyUnresolvedError)
        ) {
          throw err;
        }
        logger.warn(
          { err, userId, limitId: row.id },
          'RG limit usage unavailable: rate or currency missing',
        );
      }
    }
    const limit = row.amount;
    const remaining =
      used !== null && limit !== null
        ? moneyCompare(used, limit) >= 0
          ? '0'
          : moneySubtract(limit, used)
        : null;
    return {
      id: base.id,
      userId: base.userId,
      type: base.type,
      amount: base.amount,
      minutes: base.minutes,
      currency: toWireCurrency(row.type as LimitType, resolvedCurrency),
      period: base.period,
      createdAt: base.createdAt,
      used: used !== null ? moneyCeilToScale(used, RG_LIMIT_MONEY_SCALE) : null,
      remaining: remaining !== null ? moneyFloorToScale(remaining, RG_LIMIT_MONEY_SCALE) : null,
      pct:
        used !== null && limit !== null
          ? thresholdPct(moneyToNumber(used), moneyToNumber(limit))
          : null,
      ...(status === 'waiting' || status === 'ready'
        ? {
            pendingKind: row.pendingKind,
            pendingAmount: base.pendingAmount,
            pendingMinutes: row.pendingMinutes,
            pendingCurrency:
              row.pendingCurrency === null
                ? null
                : toWireCurrency(row.type as LimitType, row.pendingCurrency),
            pendingStatus: status,
            pendingEffectiveAt: base.pendingEffectiveAt,
            pendingExpiresAt: base.pendingExpiresAt,
          }
        : {
            pendingKind: null,
            pendingAmount: null,
            pendingMinutes: null,
            pendingCurrency: null,
            pendingStatus: null,
            pendingEffectiveAt: null,
            pendingExpiresAt: null,
          }),
    };
  }
}
