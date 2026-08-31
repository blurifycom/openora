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
  SendEmailPort,
  EmailTemplateRenderer,
  EmailTemplateData,
  EmailTemplateKey,
  AdminUserDirectory,
  IdentityReader,
  RgInitiator,
  User,
  ClientMeta,
  LimitType,
  ExchangeRateReader,
} from '@openora/core/contracts';
import { userLimit, rgExclusion, SESSION_LIMIT_CURRENCY } from '../schema/index.js';
// Read-only cross-module `/schema` subpath (module-structure.md), not a pam import - the
// same seam `KycVerificationService` already uses to read `player.currency` (see
// kyc.service.ts). Resolving a limit's currency needs the player's own currency; adding
// a new port for a single-column read here would just duplicate a seam that exists.
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

// The DB always carries a non-null currency (SESSION_LIMIT_CURRENCY sentinel for the
// session type, keeping the widened unique index's NOT NULL invariant intact); the wire
// never shows that sentinel. Both directions live together so no write/read boundary can
// apply one without the other.
export function toDbCurrency(type: LimitType, currency: string | null): string {
  return type === 'session' ? SESSION_LIMIT_CURRENCY : (currency as string);
}
// `currency` may still be null on the wire for a money-type row that has not been
// touched (and therefore not resolved, see resolveLimitCurrency below) since this
// column was added - a nullable wire field, not a bug.
export function toWireCurrency(type: LimitType, currency: string | null): string | null {
  return type === 'session' ? null : currency;
}

// A `LimitRow` whose currency is known: either the session sentinel, or a money-type
// row that has been resolved (see resolveLimitCurrency/resolveLimitCurrencyInTx below).
export type ResolvedLimitRow = Omit<LimitRow, 'currency'> & { currency: string };

// A raise and a removal both weaken the protection; a first limit and a lower one do
// not. Shared by the player's own classification (RgSelfServiceService.upsertLimit,
// where only a lower/first write applies immediately) and the admin override (below,
// where a raise is refused outright rather than parked).
//
// Money-type limits compare in the ROW's currency: same currency is a cheap direct
// `moneyCompare`; a different currency is converted via `rates.convert` before
// comparing. Fails CLOSED - if the rate is unavailable (or too stale, which the reader
// expresses the same way, as `null`), this returns `true` (treat as weakening) rather
// than letting an unverified raise through. This never throws: both callers run inside
// the same DB transaction/advisory lock that also performs the write, and "conservatively
// refuse" is a valid return value there, not an exceptional one.
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
  // A limit that changes measure (money <-> minutes) cannot happen: `type` fixes which
  // one applies and `type` is part of the row's identity. Treat the impossible case as
  // weakening rather than waving it through.
  return true;
}

/**
 * ADR-0036 amendment: the admin override is reduce-only. The ADR's original
 * "impose a limit on the spot" justification only ever needed create-or-lower; letting
 * an operator RAISE a limit the player set for themselves is the operator weakening the
 * player's own protection, which the Anjouan-licence RG policy explicitly forbids
 * (overrides may only reduce). Carries the prior and requested value so the client can
 * render a precise refusal without a message string reaching the screen.
 */
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

/**
 * One critical section per limit slot, shared by every path that reads a limit and then
 * decides what to write about it: the player's raise-or-apply classification, confirm and
 * cancel of a parked request, and the admin's outright write. Split apart, two concurrent
 * changes both classify against a value that is gone by the time either lands.
 *
 * An advisory lock (`withAdvisoryXactLock`) rather than `SELECT ... FOR UPDATE`, because
 * the row does not exist yet for a player's first limit and there would be nothing to lock.
 */
export const limitSlotKey = (userId: User['id'], type: string, period: string) =>
  `rg-limit:${userId}:${type}:${period}`;
// The "no request parked on this limit" tuple, spelled once so no write path can clear
// four of the five columns and leave a half-request behind.
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

/**
 * A pre-existing `user_limit` row (see schema/index.ts) whose currency has never been
 * resolved, and whose player record cannot be found to resolve it from. Fails the
 * operation closed - the same rule this module already applies to a missing exchange
 * rate (`RgRateUnavailableError`, rg-monitoring.service.ts): an unresolvable currency
 * means the limit cannot be safely evaluated or classified, so the caller refuses
 * rather than guessing a default currency.
 */
export class RgLimitCurrencyUnresolvedError extends Error {
  constructor(readonly userId: User['id']) {
    super(
      `Cannot resolve a currency for this responsible-gambling limit: no player record found for ${userId}`,
    );
    this.name = 'RgLimitCurrencyUnresolvedError';
  }
}

/**
 * Resolves and PERSISTS a pre-existing row's null currency (see schema/index.ts) to the
 * player's own `player.currency`, the first time anything touches it. Assumes the
 * caller is ALREADY inside the transaction and advisory lock for this limit's slot
 * (`limitSlotKey`) and re-reads the row under that lock, so a second caller racing the
 * first sees the already-resolved value instead of resolving (and writing) it twice.
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
 * Same resolution, for a caller that does NOT already hold the slot's advisory lock
 * (`RgLimitGate.check`, `RgMonitoringService.evaluateUser`, `RgSelfServiceService.toView`)
 * - opens its own transaction and takes the lock itself. Never call this from inside an
 * already-open transaction on the same slot (see `resolveLimitCurrencyInTx` above): a
 * second connection taking the same advisory lock while the outer transaction still
 * holds it would self-deadlock.
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
 * The one write that applies a limit immediately, shared by the admin override
 * (`RgService.setPlayerLimit`) and the player's create-or-lower path
 * (`RgSelfServiceService.upsertLimit`). Only the WRITE is shared: each caller classifies
 * the change itself first and diverges on a weakening one (the admin refuses it, the
 * player parks a request), which is why that decision stays out of here.
 *
 * Both callers must already hold this limit's slot lock (`limitSlotKey`) inside their own
 * transaction and must pass the `existing` row they read under it - the update pins to
 * `existing.id`.
 *
 * Not `.onConflictDoUpdate` on the widened (userId, type, period, currency) key: a write
 * that also CHANGES the currency has no conflict on that key against the existing
 * (different-currency) row, so an upsert would INSERT a second row instead of updating the
 * one the caller found. Hence the explicit branch on `existing`.
 *
 * Clearing `pending*` is deliberate: a directly written limit is the current decision, and
 * leaving a stale request parked beside it would let the player confirm their way back to
 * a value this write just moved past.
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
  email?: SendEmailPort | null;
  directory?: AdminUserDirectory | null;
  identityReader: IdentityReader;
  templateRenderer?: EmailTemplateRenderer | null;
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
  private readonly email: SendEmailPort | null;
  private readonly directory: AdminUserDirectory | null;
  private readonly identityReader: IdentityReader;
  private readonly templateRenderer: EmailTemplateRenderer | null;
  private readonly rates: ExchangeRateReader;

  constructor(deps: RgServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.loginEnforcement = deps.loginEnforcement;
    this.email = deps.email ?? null;
    this.directory = deps.directory ?? null;
    this.identityReader = deps.identityReader;
    this.templateRenderer = deps.templateRenderer ?? null;
    this.rates = deps.rates;
  }

  /**
   * The ADMIN write: a compliance officer creates a player's first limit, or lowers one
   * that already exists, effective immediately. It deliberately does NOT serve the
   * cool-down - that is a control on what a *player* may do to their own protection, not
   * a restraint on the operator's compliance function, which must be able to impose a
   * limit on the spot. It is also **reduce-only**: raising a limit the player set for
   * themselves is refused with `LimitRaiseNotAllowedError`, because that direction is the
   * operator weakening the player's own protection, not imposing one (ADR-0036
   * amendment). The override is permissioned (`compliance:manage-rg`), requires a
   * mandatory `reason` and `confirm`, and lands in the audit log attributed to the
   * admin, which is what makes it accountable. See ADR-0036.
   *
   * The player's own path never comes through here: `RgSelfServiceService.upsertLimit`
   * owns the classification and does its own write under the same per-limit lock.
   *
   * The raise check and the write share the same advisory lock and the same read: the
   * classification is only meaningful against the value still present when the write
   * lands. The write itself (including why it clears any parked request, even a player's
   * own pending RAISE) is `writeLimitRow`.
   */
  async setPlayerLimit(
    userId: User['id'],
    input: SetPlayerLimitInput,
    actorId: User['id'],
    initiatedBy: RgInitiator,
    meta?: ClientMeta,
  ): Promise<Limit> {
    // Same critical section the player's path takes, so an admin write and a player
    // request for the same limit cannot interleave into a state neither of them chose.
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
          // Resolve BEFORE classifying: a pre-existing row's null currency must be known
          // to compare it against `input.currency`, and this is the one place that
          // touches it under the slot's lock, so it also persists here.
          const resolvedExisting = await resolveLimitCurrencyInTx(tx, existing);
          if (await isWeakening(resolvedExisting, input, this.rates)) {
            throw new LimitRaiseNotAllowedError(existing, input);
          }
        }
        // `existing` was read under this same advisory lock, which is what makes the
        // shared write safe here - see `writeLimitRow`.
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
    await this.notifyLimitUpdated(userId, input.type, input.period, input.amount, input.minutes);
    return toLimitDto(row);
  }

  /**
   * The player-facing "your limit changed" mail. Public so the self-service confirm
   * path - which writes the limit itself, atomically with clearing the request that
   * authorised it - sends the same mail as this class does, rather than re-wiring the
   * renderer/directory/transport trio a second time.
   */
  async notifyLimitUpdated(
    userId: User['id'],
    type: SetPlayerLimitInput['type'],
    period: SetPlayerLimitInput['period'],
    amount: string | null,
    minutes: number | null,
  ): Promise<void> {
    await this.notify(userId, 'rgLimitUpdated', {
      period,
      type,
      description: amount ?? `${minutes} minutes`,
    });
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
    await this.notify(userId, 'rgCoolingOffActivated', { expiresAt });
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
    await this.notify(userId, 'rgSelfExclusionActivated', {
      expiresAt,
      isPermanent: input.isPermanent,
    });
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
    await this.notify(userId, 'rgSelfExclusionLifted', {});
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
    await this.notify(userId, 'rgCoolingOffLifted', {});
    return toExclusionDto(row);
  }

  /**
   * The exclusions in force for a player right now. A lapsed cooling-off row stays
   * `active` until the sweep expires it, so it is filtered out here by its expiry -
   * the section must reflect what is actually enforced, not what the row still says.
   *
   * The limits half of the RG section lives in `RgSelfServiceService.getSection`, which
   * composes this: usage and pending requests need the spend windows, which this class
   * has no business knowing about.
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

  private async notify<K extends EmailTemplateKey>(
    userId: User['id'],
    key: K,
    data: EmailTemplateData[K],
  ) {
    if (!this.email || !this.directory || !this.templateRenderer) {
      return;
    }
    try {
      const [summary] = await this.directory.lookupPlayers([userId]);
      if (!summary?.email) {
        return;
      }
      const { subject, body } = await this.templateRenderer.render(
        key,
        data,
        summary.language ?? 'en',
      );
      await this.email.send({ to: summary.email, subject, body });
    } catch (err) {
      logger.warn({ err, userId }, 'RG player notification failed');
    }
  }
}
