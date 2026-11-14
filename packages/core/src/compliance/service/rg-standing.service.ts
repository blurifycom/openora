import type { DrizzleTx } from '@openora/core/server';
import { and, asc, eq } from 'drizzle-orm';
import {
  LimitTypeSchema,
  type RgStanding,
  type RgStandingFlag,
  type RgStandingLimit,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import {
  rgExclusion,
  rgFlag,
  userLimit,
  type RgExclusion,
  type UserLimit,
} from '../schema/index.js';
import { pendingChangeStatus } from './rg-eval.js';

type ExclusionFacts = Pick<
  RgStanding,
  | 'activeExclusions'
  | 'selfExclusionsOnRecord'
  | 'lastSelfExclusionEndedAt'
  | 'lastCoolingOffEndedAt'
>;

type ExclusionRow = Pick<
  RgExclusion,
  'kind' | 'status' | 'isPermanent' | 'startsAt' | 'expiresAt' | 'liftedAt'
>;

/** Null when the user has no player profile. */
export async function readPlayerCurrency(
  tx: DrizzleTx,
  userId: User['id'],
): Promise<string | null> {
  const [row] = await tx
    .select({ currency: player.currency })
    .from(player)
    .where(eq(player.userId, userId))
    .limit(1);
  return row?.currency ?? null;
}

/**
 * A cooling-off whose end has passed is over even while the sweep has not yet marked it
 * expired, so one lifted after that ended when it ran out; a self-exclusion stays in force,
 * past its term too, until it is lifted.
 */
export async function readExclusionFacts(
  tx: DrizzleTx,
  userId: User['id'],
  now: Date,
): Promise<ExclusionFacts> {
  const rows = await tx
    .select({
      kind: rgExclusion.kind,
      status: rgExclusion.status,
      isPermanent: rgExclusion.isPermanent,
      startsAt: rgExclusion.startsAt,
      expiresAt: rgExclusion.expiresAt,
      liftedAt: rgExclusion.liftedAt,
    })
    .from(rgExclusion)
    .where(eq(rgExclusion.userId, userId))
    .orderBy(asc(rgExclusion.startsAt));
  const inForce = rows.filter((row) => isInForce(row, now));
  return {
    activeExclusions: inForce.map(({ kind, startsAt, expiresAt, isPermanent }) => ({
      kind,
      startsAt,
      expiresAt,
      isPermanent,
    })),
    selfExclusionsOnRecord: rows.filter((row) => row.kind === 'self_exclusion').length,
    lastSelfExclusionEndedAt: latestEnd(rows, 'self_exclusion', now),
    lastCoolingOffEndedAt: latestEnd(rows, 'cooling_off', now),
  };
}

function isInForce(row: ExclusionRow, now: Date): boolean {
  if (row.status !== 'active') {
    return false;
  }
  return row.kind === 'self_exclusion' || (row.expiresAt !== null && row.expiresAt > now);
}

function endedAt(row: ExclusionRow, now: Date): Date | null {
  if (row.status === 'lifted') {
    return ranOutBeforeLift(row) ? row.expiresAt : row.liftedAt;
  }
  if (row.status === 'expired') {
    return row.expiresAt;
  }
  if (row.kind === 'cooling_off' && row.expiresAt !== null && row.expiresAt <= now) {
    return row.expiresAt;
  }
  return null;
}

function ranOutBeforeLift(row: ExclusionRow): boolean {
  return (
    row.kind === 'cooling_off' &&
    row.liftedAt !== null &&
    row.expiresAt !== null &&
    row.expiresAt < row.liftedAt
  );
}

function latestEnd(rows: readonly ExclusionRow[], kind: ExclusionRow['kind'], now: Date) {
  let latest: Date | null = null;
  for (const row of rows) {
    const end = row.kind === kind ? endedAt(row, now) : null;
    if (end !== null && (latest === null || end > latest)) {
      latest = end;
    }
  }
  return latest;
}

export async function readActiveFlags(
  tx: DrizzleTx,
  userId: User['id'],
): Promise<RgStandingFlag[]> {
  const rows = await tx
    .select({
      flagType: rgFlag.flagType,
      limitType: rgFlag.limitType,
      flaggedAt: rgFlag.flaggedAt,
    })
    .from(rgFlag)
    .where(and(eq(rgFlag.userId, userId), eq(rgFlag.status, 'active')))
    .orderBy(asc(rgFlag.flaggedAt));
  return rows.map((row) => ({
    ...row,
    limitType: LimitTypeSchema.safeParse(row.limitType).data ?? null,
  }));
}

/**
 * Reads a limit stored without a currency in the player's own currency, for the reading only.
 */
export async function readLimits(
  tx: DrizzleTx,
  userId: User['id'],
  playerCurrency: string,
  now: Date,
): Promise<RgStandingLimit[]> {
  const rows = await tx
    .select({
      id: userLimit.id,
      type: userLimit.type,
      period: userLimit.period,
      amount: userLimit.amount,
      minutes: userLimit.minutes,
      currency: userLimit.currency,
      pendingKind: userLimit.pendingKind,
      pendingRequestedAt: userLimit.pendingRequestedAt,
      pendingEffectiveAt: userLimit.pendingEffectiveAt,
      pendingExpiresAt: userLimit.pendingExpiresAt,
    })
    .from(userLimit)
    .where(eq(userLimit.userId, userId))
    .orderBy(asc(userLimit.type), asc(userLimit.period));
  return rows.map((row) => toStandingLimit(row, playerCurrency, now));
}

type LimitRow = Pick<
  UserLimit,
  | 'id'
  | 'type'
  | 'period'
  | 'amount'
  | 'minutes'
  | 'currency'
  | 'pendingKind'
  | 'pendingRequestedAt'
  | 'pendingEffectiveAt'
  | 'pendingExpiresAt'
>;

function toStandingLimit(row: LimitRow, playerCurrency: string, now: Date): RgStandingLimit {
  const pending = pendingWeakening(row, now);
  if (row.type === 'session') {
    if (row.minutes === null) {
      throw new Error(`user_limit ${row.id} is a session limit without minutes`);
    }
    return { type: row.type, period: row.period, minutes: row.minutes, ...pending };
  }
  if (row.amount === null) {
    throw new Error(`user_limit ${row.id} is a money limit without an amount`);
  }
  return {
    type: row.type,
    period: row.period,
    amount: row.amount,
    currency: row.currency ?? playerCurrency,
    ...pending,
  };
}

function pendingWeakening(
  row: LimitRow,
  now: Date,
): Pick<RgStandingLimit, 'pendingKind' | 'pendingRequestedAt'> {
  const status = pendingChangeStatus(row, now);
  if (row.pendingKind === null || status === null || status === 'expired') {
    return { pendingKind: null, pendingRequestedAt: null };
  }
  return { pendingKind: row.pendingKind, pendingRequestedAt: row.pendingRequestedAt };
}
