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

// `user_limit.amount`/`pendingAmount` are numeric(MONEY_PRECISION, MONEY_SCALE) - the
// platform-wide money scale (18dp), same as every other money column. `used`/`remaining`
// are ceil/floor-rounded to this scale before they reach LimitView; at MONEY_SCALE this
// is close to a no-op against the ledger sum's own precision, but it still protects
// against any rounding noise introduced by FX conversion in spendFor.
const RG_LIMIT_MONEY_SCALE = MONEY_SCALE;

// The admin schema requires a non-empty reason and the audit trail wants one; a player
// clicking a self-service button supplies none, so the reason IS that fact.
const SELF_SERVICE_REASON = 'Player self-service request';

export const NoPendingLimitChangeError = makeNotFoundError('PendingLimitChange');

// Both of these refuse the same route with the same HTTP code, and the player needs a
// different sentence for each ("come back on the 28th" vs "that request lapsed, file it
// again"). The code alone cannot tell them apart and the message never reaches a screen,
// so each carries a stable `reason` for the client to branch on.
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
    // Read, classify and write in ONE critical section. Split apart, two concurrent
    // lowerings both measure themselves against the original value and the later one
    // lands as an immediate RAISE over the earlier: 100 -> {50, 80} in parallel ends at
    // 80 with no cool-down served. The classification is only meaningful against the
    // value that is still there when the write happens.
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
          // Resolve BEFORE classifying: a pre-existing row's null currency must be
          // known to compare it against `input.currency`, and this is the one place
          // that touches it under the slot's lock, so it also persists here.
          const resolvedExisting = await resolveLimitCurrencyInTx(tx, existing);
          if (await isWeakening(resolvedExisting, input, this.rates)) {
            return {
              applied: false as const,
              existing,
              row: await this.park(tx, existing, 'increase', input),
            };
          }
        }
        // A first limit or a lower one: it takes effect now, and it voids any request
        // parked on this limit - a directly written limit is the current decision, and
        // leaving a stale request beside it would let the player confirm their way back
        // to an older, weaker value.
        //
        // Not `.onConflictDoUpdate` on the widened (userId, type, period, currency) key:
        // see rg.service.ts's setPlayerLimit for why a currency-changing write needs an
        // explicit branch instead. `existing` was already read under this same lock.
        const dbCurrency = toDbCurrency(input.type, input.currency);
        const row = existing
          ? findOneOrThrow(
              await tx
                .update(userLimit)
                .set({
                  amount: input.amount,
                  minutes: input.minutes,
                  currency: dbCurrency,
                  ...NO_PENDING_CHANGE,
                })
                .where(eq(userLimit.id, existing.id))
                .returning(),
              new LimitNotFoundError(userId),
            )
          : findOneOrThrow(
              await tx
                .insert(userLimit)
                .values({
                  userId,
                  type: input.type,
                  amount: input.amount,
                  minutes: input.minutes,
                  currency: dbCurrency,
                  period: input.period,
                })
                .returning(),
              new LimitNotFoundError(userId),
            );
        return { applied: true as const, existing: existing ?? null, row };
      }),
    );

    // Events and mail only after the transaction commits - never from inside it.
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

  /**
   * Files a REMOVAL request. The row stays and the limit keeps applying until the player
   * confirms - dropping a limit is exactly the change the cool-down exists for.
   */
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
   * Applies a request whose cool-down has elapsed - the ONLY path that raises a limit or
   * deletes one. Returns null when the confirmed request was a removal (the limit is
   * gone); the limit's new state otherwise.
   */
  async confirmPendingChange(
    limitId: LimitRow['id'],
    userId: User['id'],
    meta?: ClientMeta,
  ): Promise<LimitView | null> {
    const target = await this.ownedLimit(limitId, userId);

    // The whole decision runs under the slot lock and every write is pinned to the exact
    // request that was read (`pendingRequestedAt`), so a confirm that raced a lowering,
    // a cancellation, or a second confirm applies nothing at all rather than resurrecting
    // a stale value or emitting the event twice.
    const outcome = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, limitSlotKey(userId, target.type, target.period), async () => {
        const reread = await this.reread(tx, limitId, userId);
        // A pending increase filed before this deploy can still carry a null currency
        // (the migration never touched it) - resolve it here, before the 'raised' branch
        // below would otherwise persist that same null again via `current.currency`.
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
          // The sweep had not got to it yet. Clear it here so the player's next attempt
          // starts from a clean row rather than hitting the same wall again.
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

        // The single write that moves a limit upward: the new amount and the clearing of
        // the request that authorised it land together, pinned to that request.
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
      // Nothing left to breach, so the flag this limit raised has to go - `evaluateUser`
      // only walks limits that still exist and would leave it standing. Re-evaluating
      // straight after is what stops the clear from also wiping a flag that ANOTHER
      // period's limit of the same type is still breaching (rg_flag has no period column).
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

  /** Withdrawing a request restores the stricter state, so it never waits on anything. */
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
          // Idempotent: cancelling nothing has already achieved what the caller wanted.
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

  /**
   * Parks a request on a limit. Always called inside the slot lock: a new request
   * REPLACES whatever was there and restarts the clock, and inheriting the old deadline
   * would let a player file, wait, then swap in a bigger number and confirm it at once.
   */
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

  /**
   * Matches the row ONLY while it still carries the exact request that was read - the
   * compare half of a compare-and-set. `pendingRequestedAt` is the version: a lowering,
   * a cancellation or a second confirm all replace or clear it, so a write pinned this
   * way applies to nothing instead of resurrecting a value the player has moved past.
   */
  private pinnedTo(row: LimitRow) {
    return and(
      eq(userLimit.id, row.id),
      isNotNull(userLimit.pendingKind),
      row.pendingRequestedAt === null
        ? isNull(userLimit.pendingRequestedAt)
        : eq(userLimit.pendingRequestedAt, row.pendingRequestedAt),
    );
  }

  /** Re-reads the row inside the lock; ownership was already asserted by the caller. */
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

  /**
   * The payload shared by the three "this request ended" topics, built from the row as it
   * was read. Callers emit the topic themselves with a literal - routing the topic
   * through a parameter would hide it from the catalog generator, which finds events by
   * scanning for `.emit('<topic>'`.
   */
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

  /** The player closed the request themselves: confirmed or cancelled. */
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

  /** System-attributed: the window closed and nobody acted. */
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
    // Full MONEY_SCALE precision, sourced from a wallet-ledger sum converted into the
    // limit's own currency - keep this exact for the pct/remaining math below. Never
    // expose it as-is. Fail-closed to null/null/null (never a 500) when a needed
    // exchange rate is unavailable - the wire schema already allows all three nullable
    // for exactly this reason; a player's own limits read must still succeed.
    let resolvedCurrency = row.currency;
    let used: string | null = null;
    if (isMoneyLimit) {
      try {
        const resolved = await resolveLimitCurrency(this.drizzle, row);
        resolvedCurrency = resolved.currency;
        used = await this.monitoring.spendFor(
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
    // `user_limit.amount` is numeric(MONEY_PRECISION, MONEY_SCALE); `used`/`remaining` are
    // derived at the same scale from a raw ledger sum, rounded here as a protective
    // control rather than a balance display: `used` rounds UP and `remaining` rounds DOWN
    // so a player is never shown more headroom than they actually have.
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
      // An expired-but-unswept request reads as no request at all - every pending field
      // goes null together, so a client never has to know that state exists and can
      // never render a Confirm button for a request the API would refuse.
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
