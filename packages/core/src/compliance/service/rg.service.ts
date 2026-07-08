import {
  DrizzleService,
  createLogger,
  makeNotFoundError,
  makeConflictError,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import { and, eq, or, gt, lte, desc } from 'drizzle-orm';
import type {
  LoginEnforcementPort,
  SendEmailPort,
  AdminUserDirectory,
} from '@openora/core/contracts';
import { userLimit, rgExclusion } from '../schema/index.js';
import type {
  Limit,
  RgExclusion,
  SetPlayerLimitInput,
  ActivateCoolingOffInput,
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

function toLimitDto(row: typeof userLimit.$inferSelect): Limit {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as Limit['type'],
    amount: row.amount,
    period: row.period as Limit['period'],
    createdAt: row.createdAt.toISOString(),
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
};

export class RgService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly loginEnforcement: LoginEnforcementPort;
  private readonly email: SendEmailPort | null;
  private readonly directory: AdminUserDirectory | null;

  constructor(deps: RgServiceDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.loginEnforcement = deps.loginEnforcement;
    this.email = deps.email ?? null;
    this.directory = deps.directory ?? null;
  }

  async setPlayerLimit(
    userId: string,
    input: SetPlayerLimitInput,
    actorId: string,
  ): Promise<Limit> {
    const [prior] = await this.drizzle.db
      .select({ amount: userLimit.amount })
      .from(userLimit)
      .where(
        and(
          eq(userLimit.userId, userId),
          eq(userLimit.type, input.type),
          eq(userLimit.period, input.period),
        ),
      )
      .limit(1);
    const [row] = await this.drizzle.db
      .insert(userLimit)
      .values({ ...input, userId })
      .onConflictDoUpdate({
        target: [userLimit.userId, userLimit.type, userLimit.period],
        set: { amount: input.amount },
      })
      .returning();
    this.events.emit('rg.limit.set', {
      userId,
      actorId,
      limitId: row!.id,
      type: input.type,
      period: input.period,
      amount: input.amount,
      previousAmount: prior?.amount ?? null,
    });
    await this.notify(
      userId,
      'Your gambling limit was updated',
      `A ${input.period} ${input.type} limit of ${input.amount} is now active on your account.`,
    );
    return toLimitDto(row!);
  }

  async activateCoolingOff(
    userId: string,
    input: ActivateCoolingOffInput,
    actorId: string,
  ): Promise<RgExclusion> {
    await this.assertNoActiveExclusion(userId, 'cooling_off');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationHours * HOUR_MS);
    const row = await this.drizzle.db.transaction(async (tx) => {
      await this.expireLapsedCoolingOff(userId, tx, now);
      const [r] = await tx
        .insert(rgExclusion)
        .values({
          userId,
          kind: 'cooling_off',
          status: 'active',
          reason: input.reason,
          permanent: false,
          startsAt: now,
          expiresAt,
          createdBy: actorId,
        })
        .returning();
      await this.syncEnforcement(userId, tx);
      return r!;
    });
    this.events.emit('rg.cooling_off.activated', {
      userId,
      actorId,
      exclusionId: row.id,
      expiresAt: expiresAt.toISOString(),
      reason: input.reason,
    });
    await this.notify(
      userId,
      'Cooling-off period activated',
      `A cooling-off period is active on your account until ${expiresAt.toISOString()}.`,
    );
    return toExclusionDto(row);
  }

  async activateSelfExclusion(
    userId: string,
    input: ActivateSelfExclusionInput,
    actorId: string,
  ): Promise<RgExclusion> {
    await this.assertNoActiveExclusion(userId, 'self_exclusion');
    const now = new Date();
    const expiresAt =
      input.permanent || input.durationMonths === undefined
        ? null
        : addMonths(now, input.durationMonths);
    const row = await this.drizzle.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(rgExclusion)
        .values({
          userId,
          kind: 'self_exclusion',
          status: 'active',
          reason: input.reason,
          permanent: input.permanent,
          startsAt: now,
          expiresAt,
          createdBy: actorId,
        })
        .returning();
      await this.syncEnforcement(userId, tx);
      return r!;
    });
    this.events.emit('rg.self_exclusion.activated', {
      userId,
      actorId,
      exclusionId: row.id,
      permanent: input.permanent,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      reason: input.reason,
    });
    await this.notify(
      userId,
      'Self-exclusion activated',
      input.permanent
        ? 'A permanent self-exclusion is now active on your account.'
        : `A self-exclusion is active on your account until at least ${expiresAt!.toISOString()}.`,
    );
    return toExclusionDto(row);
  }

  async liftSelfExclusion(
    userId: string,
    input: LiftSelfExclusionInput,
    actorId: string,
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
    if (!existing) throw new ExclusionNotFoundError(userId);
    if (existing.permanent || existing.expiresAt === null) throw new PermanentExclusionLiftError();
    if (new Date() < existing.expiresAt) throw new ExclusionPeriodNotElapsedError();

    const now = new Date();
    const row = await this.drizzle.db.transaction(async (tx) => {
      const [r] = await tx
        .update(rgExclusion)
        .set({ status: 'lifted', liftedAt: now, liftedReason: input.reason, liftedBy: actorId })
        .where(eq(rgExclusion.id, existing.id))
        .returning();
      // Recompute from what remains - a still-active cooling-off keeps its own block
      // rather than being cleared by this lift.
      await this.syncEnforcement(userId, tx);
      return r!;
    });
    this.events.emit('rg.self_exclusion.lifted', {
      userId,
      actorId,
      exclusionId: row.id,
      kind: 'self_exclusion',
      reason: input.reason,
    });
    await this.notify(
      userId,
      'Self-exclusion lifted',
      'Your self-exclusion has been lifted and you can log in again.',
    );
    return toExclusionDto(row);
  }

  async getRgSection(userId: string): Promise<RgSection> {
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
      .returning({ userId: rgExclusion.userId });
    for (const userId of new Set(lapsed.map((r) => r.userId))) {
      await this.syncEnforcement(userId);
    }
  }

  private expireLapsedCoolingOff(userId: string, tx: Tx, now: Date) {
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
      );
  }

  // The single source of truth for the login block: derive it from the STRONGEST
  // remaining active exclusion. An active self-exclusion (permanent or fixed-term)
  // wins with an indefinite block; otherwise the longest active cooling-off; else clear.
  private async syncEnforcement(userId: string, db: Db | Tx = this.drizzle.db): Promise<void> {
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

  private async assertNoActiveExclusion(userId: string, kind: RgExclusion['kind']) {
    const now = new Date();
    const conditions = [
      eq(rgExclusion.userId, userId),
      eq(rgExclusion.kind, kind),
      eq(rgExclusion.status, 'active'),
    ];
    // A lapsed-but-not-yet-swept cooling-off must not block a fresh one; a self-exclusion
    // has no time-based lapse (only an explicit lift clears it).
    if (kind === 'cooling_off') conditions.push(gt(rgExclusion.expiresAt, now));
    const [existing] = await this.drizzle.db
      .select({ id: rgExclusion.id })
      .from(rgExclusion)
      .where(and(...conditions))
      .limit(1);
    if (existing) throw new ActiveExclusionError();
  }

  // Best-effort player notification. Both the email port and the directory are optional
  // (guarded by c.has at wiring). A lookup/send failure must not fail an RG action that
  // already committed - log without PII (no email, no reason text) and move on.
  private async notify(userId: string, subject: string, body: string) {
    if (!this.email || !this.directory) return;
    try {
      const [summary] = await this.directory.lookupPlayers([userId]);
      if (!summary?.email) return;
      await this.email.send({ to: summary.email, subject, body });
    } catch (err) {
      logger.warn({ err, userId }, 'RG player notification failed');
    }
  }
}
