import {
  DrizzleService,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  makeConflictError,
  moneyCompare,
  serializeRow,
  mapConcurrent,
  withAdvisoryXactLock,
  type EventBus,
} from '@openora/core/server';
import { and, eq, or, gt, lte, desc } from 'drizzle-orm';
import type {
  LoginEnforcementPort,
  MailDispatchPort,
  MailTemplate,
  MailToUserInput,
  IdentityReader,
  RgInitiator,
  User,
  ClientMeta,
  LimitType,
  ExchangeRateReader,
} from '@openora/core/contracts';
import { userLimit, rgExclusion, SESSION_LIMIT_CURRENCY } from '../schema/index.js';
import { player } from '@openora/core/pam/schema/profile';
import { LimitNotFoundError } from './compliance.service.js';
import type {
  Limit,
  RgExclusion,
  SetPlayerLimitInput,
  ActivateCoolingOffInput,
  LiftCoolingOffInput,
  ActivateSelfExclusionInput,
  LiftSelfExclusionInput,
  UpsertLimitInput,
} from '../contract/index.js';

const logger = createLogger('compliance-rg');

type Db = DrizzleService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const ExclusionNotFoundError = makeNotFoundError('Exclusion');
export const ActiveExclusionError = makeConflictError(
  'ActiveExclusionError',
  'An active exclusion of this kind already exists for this player',
);
export const PermanentExclusionLiftError = makeConflictError(
  'PermanentExclusionLiftError',
  'A permanent self-exclusion cannot be lifted',
);
export const ExclusionPeriodNotElapsedError = makeConflictError(
  'ExclusionPeriodNotElapsedError',
  'The self-exclusion minimum period has not elapsed yet',
);

export type LimitRow = typeof userLimit.$inferSelect;

export function toDbCurrency(type: LimitType, currency: string | null): string {
  return type === 'session' ? SESSION_LIMIT_CURRENCY : (currency as string);
}
export function toWireCurrency(type: LimitType, currency: string | null): string | null {
  return type === 'session' ? null : currency;
}

export type ResolvedLimitRow = Omit<LimitRow, 'currency'> & { currency: string };

export async function isWeakening(
  row: ResolvedLimitRow,
  next: Pick<UpsertLimitInput, 'amount' | 'minutes' | 'currency'>,
  rates: ExchangeRateReader,
): Promise<boolean> {
  if (next.amount !== null && row.amount !== null) {
    const nextCurrency = toDbCurrency(row.type as LimitType, next.currency);
    if (nextCurrency === row.currency) {
      return moneyCompare(next.amount, row.amount) > 0;
    }
    const converted = await rates.convert(next.amount, nextCurrency, row.currency);
    if (converted === null) {
      return true;
    }
    return moneyCompare(converted, row.amount) > 0;
  }
  if (next.minutes !== null && row.minutes !== null) {
    return next.minutes > row.minutes;
  }
  return true;
}

export type LimitRaiseNotAllowedData = {
  type: LimitRow['type'];
  period: LimitRow['period'];
  previousAmount: string | null;
  previousMinutes: number | null;
  requestedAmount: string | null;
  requestedMinutes: number | null;
};

export class LimitRaiseNotAllowedError extends Error {
  readonly data: LimitRaiseNotAllowedData;

  constructor(row: LimitRow, input: Pick<SetPlayerLimitInput, 'amount' | 'minutes'>) {
    super(
      'An admin override may only create or lower a player limit; raising one the player controls is not permitted',
    );
    this.name = 'LimitRaiseNotAllowedError';
    this.data = {
      type: row.type,
      period: row.period,
      previousAmount: row.amount,
      previousMinutes: row.minutes,
      requestedAmount: input.amount,
      requestedMinutes: input.minutes,
    };
  }
}

const HOUR_MS = 60 * 60 * 1000;

export const limitSlotKey = (userId: User['id'], type: string, period: string) =>
  `rg-limit:${userId}:${type}:${period}`;
export const NO_PENDING_CHANGE = {
  pendingKind: null,
  pendingAmount: null,
  pendingMinutes: null,
  pendingCurrency: null,
  pendingRequestedAt: null,
  pendingEffectiveAt: null,
  pendingExpiresAt: null,
} as const;
// Cap in-flight enforcement syncs per sweep tick so a large lapsed-cooling-off batch can't
// exhaust the shared pg pool (matches SWEEP_CONCURRENCY in rg-monitoring.service.ts).
const SWEEP_CONCURRENCY = 10;

export class RgLimitCurrencyUnresolvedError extends Error {
  constructor(readonly userId: User['id']) {
    super(
      `Cannot resolve a currency for this responsible-gambling limit: no player record found for ${userId}`,
    );
    this.name = 'RgLimitCurrencyUnresolvedError';
  }
}

/**
 * Resolves and persists a pre-existing row's null currency to the player's own
 * `player.currency`. Caller must already hold the transaction and advisory lock for
 * this limit's slot (`limitSlotKey`).
 */
export async function resolveLimitCurrencyInTx(tx: Tx, row: LimitRow): Promise<ResolvedLimitRow> {
  if (row.currency !== null) {
    return row as ResolvedLimitRow;
  }
  const [current] = await tx.select().from(userLimit).where(eq(userLimit.id, row.id));
  if (!current) {
    throw new LimitNotFoundError(row.id);
  }
  if (current.currency !== null) {
    return current as ResolvedLimitRow;
  }
  const [playerRow] = await tx
    .select({ currency: player.currency })
    .from(player)
    .where(eq(player.userId, row.userId));
  if (!playerRow) {
    throw new RgLimitCurrencyUnresolvedError(row.userId);
  }
  const [updated] = await tx
    .update(userLimit)
    .set({ currency: playerRow.currency })
    .where(eq(userLimit.id, row.id))
    .returning();
  return { ...(updated ?? current), currency: playerRow.currency };
}

/**
 * Same resolution, for a caller that holds no transaction: opens its own transaction and
 * takes the lock itself. Never call from inside an already-open transaction on the same
 * slot - use `resolveLimitCurrencyInTx` there instead, or a second connection taking the
 * same advisory lock self-deadlocks.
 */
export async function resolveLimitCurrency(
  drizzle: DrizzleService,
  row: LimitRow,
): Promise<ResolvedLimitRow> {
  if (row.currency !== null) {
    return row as ResolvedLimitRow;
  }
  return drizzle.db.transaction((tx) =>
    withAdvisoryXactLock(tx, limitSlotKey(row.userId, row.type, row.period), () =>
      resolveLimitCurrencyInTx(tx, row),
    ),
  );
}

/**
 * Applies a limit immediately and clears any parked pending request. Caller must
 * already hold this limit's slot lock (`limitSlotKey`) inside their own transaction and
 * must pass the `existing` row read under it - the update pins to `existing.id`.
 */
export async function writeLimitRow(
  tx: Tx,
  userId: User['id'],
  existing: LimitRow | undefined,
  input: Pick<UpsertLimitInput, 'type' | 'amount' | 'minutes' | 'currency' | 'period'>,
): Promise<LimitRow> {
  const currency = toDbCurrency(input.type, input.currency);
  if (existing) {
    return findOneOrThrow(
      await tx
        .update(userLimit)
        .set({
          amount: input.amount,
          minutes: input.minutes,
          currency,
          ...NO_PENDING_CHANGE,
        })
        .where(eq(userLimit.id, existing.id))
        .returning(),
      new LimitNotFoundError(userId),
    );
  }
  return findOneOrThrow(
    await tx
      .insert(userLimit)
      .values({
        userId,
        type: input.type,
        amount: input.amount,
        minutes: input.minutes,
        currency,
        period: input.period,
      })
      .returning(),
    new LimitNotFoundError(userId),
  );
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toLimitDto(row: typeof userLimit.$inferSelect) {
  return {
    ...serializeRow(row, { dateFields: ['createdAt'] }),
    currency: toWireCurrency(row.type as LimitType, row.currency),
  };
}

function toExclusionDto(row: typeof rgExclusion.$inferSelect) {
  return serializeRow(row, {
    dateFields: ['startsAt', 'expiresAt', 'liftedAt', 'createdAt', 'updatedAt'],
  });
}

export type RgServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  loginEnforcement: LoginEnforcementPort;
  identityReader: IdentityReader;
  mailDispatch?: MailDispatchPort | null;
  rates: ExchangeRateReader;
};

/**
 * Owns player-facing and admin responsible-gambling controls: deposit/session
 * limits, cooling-off, and self-exclusion. Every mutation that changes the set
 * of active exclusions ends by recomputing login enforcement from scratch
 * (`syncEnforcement`) rather than patching it incrementally, so a lift/expiry
 * of one exclusion can never leave a stale block from another. Precedence:
 * an active self-exclusion always wins with an indefinite block; otherwise
 * the longest-expiring active cooling-off; otherwise unblocked.
 */
export class RgService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly loginEnforcement: LoginEnforcementPort;
  private readonly identityReader: IdentityReader;
  private readonly mailDispatch: MailDispatchPort | null;
  private readonly rates: ExchangeRateReader;

  constructor(deps: RgServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.loginEnforcement = deps.loginEnforcement;
    this.identityReader = deps.identityReader;
    this.mailDispatch = deps.mailDispatch ?? null;
    this.rates = deps.rates;
  }

  /**
   * Admin override: creates a player's first limit or lowers an existing one, effective
   * immediately, with no cool-down. Reduce-only - raising a limit the player set for
   * themselves throws `LimitRaiseNotAllowedError`.
   */
  async setPlayerLimit(
    userId: User['id'],
    input: SetPlayerLimitInput,
    actorId: User['id'],
    initiatedBy: RgInitiator,
    meta?: ClientMeta,
  ): Promise<Limit> {
    const { prior, row } = await this.drizzle.db.transaction((tx) =>
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
            throw new LimitRaiseNotAllowedError(existing, input);
          }
        }
        return { prior: existing, row: await writeLimitRow(tx, userId, existing, input) };
      }),
    );
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    if (prior?.pendingKind) {
      this.events.emit('rg.limit.change_cancelled', {
        userId,
        playerId,
        actorId,
        limitId: row.id,
        type: input.type,
        period: input.period,
        kind: prior.pendingKind,
        previousAmount: prior.amount,
        previousMinutes: prior.minutes,
        requestedAmount: prior.pendingAmount,
        requestedMinutes: prior.pendingMinutes,
        initiatedBy,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    this.events.emit('rg.limit.set', {
      userId,
      playerId,
      actorId,
      limitId: row.id,
      type: input.type,
      period: input.period,
      amount: input.amount,
      minutes: input.minutes,
      previousAmount: prior?.amount ?? null,
      previousMinutes: prior?.minutes ?? null,
      initiatedBy,
      reason: input.reason,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.notifyLimitUpdated(userId, row);
    return toLimitDto(row);
  }

  async notifyLimitUpdated(userId: User['id'], row: LimitRow): Promise<void> {
    await this.notify(
      userId,
      {
        key: 'rgLimitUpdated',
        data: {
          period: row.period,
          type: row.type,
          description: row.amount ?? `${row.minutes} minutes`,
        },
      },
      `${row.id}:${row.updatedAt.toISOString()}`,
    );
  }

  async activateCoolingOff(
    userId: User['id'],
    input: ActivateCoolingOffInput,
    actorId: User['id'],
    initiatedBy: RgInitiator,
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    await this.assertNoActiveExclusion(userId, 'cooling_off');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationHours * HOUR_MS);
    const { row, lapsed } = await this.drizzle.db.transaction(async (tx) => {
      const lapsedRows = await this.expireLapsedCoolingOff(userId, tx, now);
      const r = findOneOrThrow(
        await tx
          .insert(rgExclusion)
          .values({
            userId,
            kind: 'cooling_off',
            status: 'active',
            reason: input.reason,
            isPermanent: false,
            startsAt: now,
            expiresAt,
            createdBy: actorId,
          })
          .returning(),
        new ExclusionNotFoundError(userId),
      );
      await this.syncEnforcement(userId, tx);
      return { row: r, lapsed: lapsedRows };
    });
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    for (const lapsedRow of lapsed) {
      this.events.emit('rg.cooling_off.expired', {
        userId,
        playerId,
        exclusionId: lapsedRow.id,
        expiresAt: (lapsedRow.expiresAt ?? now).toISOString(),
      });
    }
    this.events.emit('rg.cooling_off.activated', {
      userId,
      playerId,
      actorId,
      exclusionId: row.id,
      expiresAt: expiresAt.toISOString(),
      reason: input.reason,
      initiatedBy,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.notify(
      userId,
      { key: 'rgCoolingOffActivated', data: { expiresAt: expiresAt.toISOString() } },
      row.id,
    );
    return toExclusionDto(row);
  }

  /**
   * `isPermanent: true` stores `expiresAt: null` - a permanent exclusion has
   * no time-based lapse and can only ever be cleared by an explicit
   * `liftSelfExclusion` (which itself rejects lifting a permanent one). Only
   * one active self-exclusion may exist per player at a time.
   */
  async activateSelfExclusion(
    userId: User['id'],
    input: ActivateSelfExclusionInput,
    actorId: User['id'],
    initiatedBy: RgInitiator,
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    await this.assertNoActiveExclusion(userId, 'self_exclusion');
    const now = new Date();
    const expiresAt =
      input.isPermanent || input.durationMonths === undefined
        ? null
        : addMonths(now, input.durationMonths);
    const row = await this.drizzle.db.transaction(async (tx) => {
      const r = findOneOrThrow(
        await tx
          .insert(rgExclusion)
          .values({
            userId,
            kind: 'self_exclusion',
            status: 'active',
            reason: input.reason,
            isPermanent: input.isPermanent,
            startsAt: now,
            expiresAt,
            createdBy: actorId,
          })
          .returning(),
        new ExclusionNotFoundError(userId),
      );
      await this.syncEnforcement(userId, tx);
      return r;
    });
    this.events.emit('rg.self_exclusion.activated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      exclusionId: row.id,
      isPermanent: input.isPermanent,
      durationMonths: input.isPermanent ? null : (input.durationMonths ?? null),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      reason: input.reason,
      initiatedBy,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.notify(
      userId,
      {
        key: 'rgSelfExclusionActivated',
        data: {
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          isPermanent: input.isPermanent,
        },
      },
      row.id,
    );
    return toExclusionDto(row);
  }

  /**
   * A permanent self-exclusion (`isPermanent`/`expiresAt: null`) can never be
   * lifted through this path (`PermanentExclusionLiftError`) - by design,
   * there is no self-service or admin override. A fixed-term exclusion can
   * only be lifted once its minimum period has actually elapsed
   * (`ExclusionPeriodNotElapsedError` otherwise), even for an admin actor.
   */
  async liftSelfExclusion(
    userId: User['id'],
    input: LiftSelfExclusionInput,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    const [existing] = await this.drizzle.db
      .select()
      .from(rgExclusion)
      .where(
        and(
          eq(rgExclusion.userId, userId),
          eq(rgExclusion.kind, 'self_exclusion'),
          eq(rgExclusion.status, 'active'),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new ExclusionNotFoundError(userId);
    }
    if (existing.isPermanent || existing.expiresAt === null) {
      throw new PermanentExclusionLiftError();
    }
    if (new Date() < existing.expiresAt) {
      throw new ExclusionPeriodNotElapsedError();
    }

    const now = new Date();
    const row = await this.drizzle.db.transaction(async (tx) => {
      const r = findOneOrThrow(
        await tx
          .update(rgExclusion)
          .set({ status: 'lifted', liftedAt: now, liftedReason: input.reason, liftedBy: actorId })
          .where(eq(rgExclusion.id, existing.id))
          .returning(),
        new ExclusionNotFoundError(existing.id),
      );
      // Recompute from what remains - a still-active cooling-off keeps its own block
      // rather than being cleared by this lift.
      await this.syncEnforcement(userId, tx);
      return r;
    });
    this.events.emit('rg.self_exclusion.lifted', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      exclusionId: row.id,
      kind: 'self_exclusion',
      reason: input.reason,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.notify(userId, { key: 'rgSelfExclusionLifted', data: {} }, row.id);
    return toExclusionDto(row);
  }

  /**
   * Ends an active cooling-off early. Unlike `liftSelfExclusion` there is no minimum
   * period and no permanent variant to refuse - a cooling-off is a support action an
   * admin must be able to reverse. `syncEnforcement` still recomputes the block from
   * what remains, so a player who is ALSO self-excluded stays blocked after this lift.
   */
  async liftCoolingOff(
    userId: User['id'],
    input: LiftCoolingOffInput,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<RgExclusion> {
    const [existing] = await this.drizzle.db
      .select()
      .from(rgExclusion)
      .where(
        and(
          eq(rgExclusion.userId, userId),
          eq(rgExclusion.kind, 'cooling_off'),
          eq(rgExclusion.status, 'active'),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new ExclusionNotFoundError(userId);
    }

    const now = new Date();
    const row = await this.drizzle.db.transaction(async (tx) => {
      const r = findOneOrThrow(
        await tx
          .update(rgExclusion)
          .set({ status: 'lifted', liftedAt: now, liftedReason: input.reason, liftedBy: actorId })
          .where(eq(rgExclusion.id, existing.id))
          .returning(),
        new ExclusionNotFoundError(existing.id),
      );
      await this.syncEnforcement(userId, tx);
      return r;
    });
    this.events.emit('rg.cooling_off.lifted', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      exclusionId: row.id,
      reason: input.reason,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    await this.notify(userId, { key: 'rgCoolingOffLifted', data: {} }, row.id);
    return toExclusionDto(row);
  }

  /**
   * The exclusions in force for a player right now. A lapsed cooling-off row stays
   * `active` until the sweep expires it, so it is filtered out here by its expiry.
   */
  async getActiveExclusions(
    userId: User['id'],
  ): Promise<{ coolingOff: RgExclusion | null; selfExclusion: RgExclusion | null }> {
    const now = new Date();
    const exclusions = await this.drizzle.db
      .select()
      .from(rgExclusion)
      .where(and(eq(rgExclusion.userId, userId), eq(rgExclusion.status, 'active')))
      .orderBy(desc(rgExclusion.createdAt));
    const coolingOff =
      exclusions.find((e) => e.kind === 'cooling_off' && e.expiresAt && e.expiresAt > now) ?? null;
    const selfExclusion = exclusions.find((e) => e.kind === 'self_exclusion') ?? null;
    return {
      coolingOff: coolingOff ? toExclusionDto(coolingOff) : null,
      selfExclusion: selfExclusion ? toExclusionDto(selfExclusion) : null,
    };
  }

  // Background hygiene: transition truly-lapsed cooling-off rows to `expired` and
  // recompute enforcement for the affected players. Called by the rg-monitor sweep.
  async expireLapsedCoolingOffs(): Promise<void> {
    const now = new Date();
    const lapsed = await this.drizzle.db
      .update(rgExclusion)
      .set({ status: 'expired' })
      .where(
        and(
          eq(rgExclusion.kind, 'cooling_off'),
          eq(rgExclusion.status, 'active'),
          lte(rgExclusion.expiresAt, now),
        ),
      )
      .returning({
        id: rgExclusion.id,
        userId: rgExclusion.userId,
        expiresAt: rgExclusion.expiresAt,
      });
    const lapsedUserIds = [...new Set(lapsed.map((r) => r.userId))];
    await mapConcurrent(lapsedUserIds, SWEEP_CONCURRENCY, (userId) => this.syncEnforcement(userId));
    const playerIds = await this.identityReader.getPlayerIdsByUserIdsSafe(
      lapsed.map((r) => r.userId),
    );
    for (const row of lapsed) {
      this.events.emit('rg.cooling_off.expired', {
        userId: row.userId,
        playerId: playerIds.get(row.userId) ?? null,
        exclusionId: row.id,
        expiresAt: (row.expiresAt ?? now).toISOString(),
      });
    }
  }

  private expireLapsedCoolingOff(userId: User['id'], tx: Tx, now: Date) {
    return tx
      .update(rgExclusion)
      .set({ status: 'expired' })
      .where(
        and(
          eq(rgExclusion.userId, userId),
          eq(rgExclusion.kind, 'cooling_off'),
          eq(rgExclusion.status, 'active'),
          lte(rgExclusion.expiresAt, now),
        ),
      )
      .returning({
        id: rgExclusion.id,
        userId: rgExclusion.userId,
        expiresAt: rgExclusion.expiresAt,
      });
  }

  // The single source of truth for the login block: derive it from the STRONGEST
  // remaining active exclusion. An active self-exclusion (permanent or fixed-term)
  // wins with an indefinite block; otherwise the longest active cooling-off; else clear.
  private async syncEnforcement(userId: User['id'], db: Db | Tx = this.drizzle.db): Promise<void> {
    const now = new Date();
    const active = await db
      .select({ kind: rgExclusion.kind, expiresAt: rgExclusion.expiresAt })
      .from(rgExclusion)
      .where(
        and(
          eq(rgExclusion.userId, userId),
          eq(rgExclusion.status, 'active'),
          or(eq(rgExclusion.kind, 'self_exclusion'), gt(rgExclusion.expiresAt, now)),
        ),
      );
    if (active.some((e) => e.kind === 'self_exclusion')) {
      await this.loginEnforcement.block(userId, { until: null });
      return;
    }
    const expiries = active.filter((e) => e.expiresAt).map((e) => (e.expiresAt as Date).getTime());
    if (expiries.length > 0) {
      await this.loginEnforcement.block(userId, { until: new Date(Math.max(...expiries)) });
      return;
    }
    await this.loginEnforcement.unblock(userId);
  }

  private async assertNoActiveExclusion(userId: User['id'], kind: RgExclusion['kind']) {
    const now = new Date();
    const conditions = [
      eq(rgExclusion.userId, userId),
      eq(rgExclusion.kind, kind),
      eq(rgExclusion.status, 'active'),
    ];
    // A lapsed-but-not-yet-swept cooling-off must not block a fresh one; a self-exclusion
    // has no time-based lapse (only an explicit lift clears it).
    if (kind === 'cooling_off') {
      conditions.push(gt(rgExclusion.expiresAt, now));
    }
    const [existing] = await this.drizzle.db
      .select({ id: rgExclusion.id })
      .from(rgExclusion)
      .where(and(...conditions))
      .limit(1);
    if (existing) {
      throw new ActiveExclusionError();
    }
  }

  // `notificationId` (the limit/exclusion row) keys the send so a retried mutation
  // never doubles the mail. Failure is logged, not thrown - the change is committed.
  private async notify(
    userId: User['id'],
    template: MailTemplate,
    notificationId: MailToUserInput['idempotencyKey'],
  ) {
    if (!this.mailDispatch) {
      return;
    }
    try {
      await this.mailDispatch.toUser({
        userId,
        template,
        idempotencyKey: `rg-notify:${template.key}:${notificationId}`,
      });
    } catch (err) {
      logger.error({ err, userId, key: template.key }, 'RG player mail enqueue failed');
    }
  }
}
