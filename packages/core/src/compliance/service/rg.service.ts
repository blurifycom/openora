import {
  DrizzleService,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  makeConflictError,
  serializeRow,
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
  User,
  ClientMeta,
} from '@openora/core/contracts';
import { userLimit, rgExclusion } from '../schema/index.js';
import { LimitNotFoundError } from './compliance.service.js';
import type {
  Limit,
  RgExclusion,
  SetPlayerLimitInput,
  ActivateCoolingOffInput,
  LiftCoolingOffInput,
  ActivateSelfExclusionInput,
  LiftSelfExclusionInput,
  RgSection,
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

const HOUR_MS = 60 * 60 * 1000;

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toLimitDto(row: typeof userLimit.$inferSelect) {
  return serializeRow(row, { dateFields: ['createdAt'] });
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

  constructor(deps: RgServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.loginEnforcement = deps.loginEnforcement;
    this.email = deps.email ?? null;
    this.directory = deps.directory ?? null;
    this.identityReader = deps.identityReader;
    this.templateRenderer = deps.templateRenderer ?? null;
  }

  async setPlayerLimit(
    userId: User['id'],
    input: SetPlayerLimitInput,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<Limit> {
    const [prior] = await this.drizzle.db
      .select({ amount: userLimit.amount, minutes: userLimit.minutes })
      .from(userLimit)
      .where(
        and(
          eq(userLimit.userId, userId),
          eq(userLimit.type, input.type),
          eq(userLimit.period, input.period),
        ),
      )
      .limit(1);
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(userLimit)
        .values({ ...input, userId })
        .onConflictDoUpdate({
          target: [userLimit.userId, userLimit.type, userLimit.period],
          set: { amount: input.amount, minutes: input.minutes },
        })
        .returning(),
      new LimitNotFoundError(userId),
    );
    this.events.emit('rg.limit.set', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      limitId: row.id,
      type: input.type,
      period: input.period,
      amount: input.amount,
      minutes: input.minutes,
      previousAmount: prior?.amount ?? null,
      previousMinutes: prior?.minutes ?? null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    const limitDescription = input.amount ?? `${input.minutes} minutes`;
    await this.notify(userId, 'rgLimitUpdated', {
      period: input.period,
      type: input.type,
      description: limitDescription,
    });
    return toLimitDto(row);
  }

  async activateCoolingOff(
    userId: User['id'],
    input: ActivateCoolingOffInput,
    actorId: User['id'],
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
        // The lapsed row's own filter (`lte(expiresAt, now)`) only ever matches a
        // non-null expiresAt - `now` is an unreachable fallback, not a real default.
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

  async getRgSection(userId: User['id']): Promise<RgSection> {
    const now = new Date();
    const [limits, exclusions] = await Promise.all([
      this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId)),
      this.drizzle.db
        .select()
        .from(rgExclusion)
        .where(and(eq(rgExclusion.userId, userId), eq(rgExclusion.status, 'active')))
        .orderBy(desc(rgExclusion.createdAt)),
    ]);
    // A lapsed cooling-off row stays `active` until the sweep expires it - treat it as
    // not-active here so the section reflects the enforced state.
    const coolingOff =
      exclusions.find((e) => e.kind === 'cooling_off' && e.expiresAt && e.expiresAt > now) ?? null;
    const selfExclusion = exclusions.find((e) => e.kind === 'self_exclusion') ?? null;
    return {
      limits: limits.map(toLimitDto),
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
    for (const userId of new Set(lapsed.map((r) => r.userId))) {
      await this.syncEnforcement(userId);
    }
    for (const row of lapsed) {
      this.events.emit('rg.cooling_off.expired', {
        userId: row.userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(row.userId),
        exclusionId: row.id,
        // The `lte` filter above only ever matches a non-null expiresAt - a cooling-off
        // row always sets one - so `now` is an unreachable fallback, not a real default.
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
