import type { DrizzleDb } from '@openora/core/server';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  LimitTypeSchema,
  type RgStanding,
  type RgStandingFlag,
  type RgStandingLimit,
  type RgStandingWindow,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  rgExclusion,
  rgFlag,
  userLimit,
  type RgExclusion,
  type UserLimit,
} from '../schema/index.js';

export type RgMoneyMetric = keyof NonNullable<RgStandingWindow['totals']>;

export type RgMoneyRow = {
  metric: RgMoneyMetric;
  currency: string;
  /** One decimal string per requested window start, in the order given. */
  totals: string[];
};

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
  db: DrizzleDb,
  userId: User['id'],
): Promise<string | null> {
  const [row] = await db
    .select({ currency: player.currency })
    .from(player)
    .where(eq(player.userId, userId))
    .limit(1);
  return row?.currency ?? null;
}

/**
 * A cooling-off whose end has passed is over even while the sweep has not yet marked it
 * expired; a self-exclusion stays in force, past its term too, until it is lifted.
 */
export async function readExclusionFacts(
  db: DrizzleDb,
  userId: User['id'],
  now: Date,
): Promise<ExclusionFacts> {
  const rows = await db
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
    return row.liftedAt;
  }
  if (row.status === 'expired') {
    return row.expiresAt;
  }
  if (row.kind === 'cooling_off' && row.expiresAt !== null && row.expiresAt <= now) {
    return row.expiresAt;
  }
  return null;
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
  db: DrizzleDb,
  userId: User['id'],
): Promise<RgStandingFlag[]> {
  const rows = await db
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
 * Resolves a limit stored without a currency to the player's own currency for the reading only:
 * the write that fills it in belongs to the limit's own lock (`resolveLimitCurrencyInTx`).
 */
export async function readLimits(
  db: DrizzleDb,
  userId: User['id'],
  playerCurrency: string,
): Promise<RgStandingLimit[]> {
  const rows = await db
    .select({
      id: userLimit.id,
      type: userLimit.type,
      period: userLimit.period,
      amount: userLimit.amount,
      minutes: userLimit.minutes,
      currency: userLimit.currency,
    })
    .from(userLimit)
    .where(eq(userLimit.userId, userId))
    .orderBy(asc(userLimit.type), asc(userLimit.period));
  return rows.map((row) => toStandingLimit(row, playerCurrency));
}

function toStandingLimit(
  row: Pick<UserLimit, 'id' | 'type' | 'period' | 'amount' | 'minutes' | 'currency'>,
  playerCurrency: string,
): RgStandingLimit {
  if (row.type === 'session') {
    if (row.minutes === null) {
      throw new Error(`user_limit ${row.id} is a session limit without minutes`);
    }
    return { type: row.type, period: row.period, minutes: row.minutes };
  }
  if (row.amount === null) {
    throw new Error(`user_limit ${row.id} is a money limit without an amount`);
  }
  return {
    type: row.type,
    period: row.period,
    amount: row.amount,
    currency: row.currency ?? playerCurrency,
  };
}

/**
 * Completed deposits, stakes net of reversals, and wins per currency, one total per window start.
 * A deposit counts from when it reached the balance: a held deposit from its release.
 */
export async function readMoneyByWindow(
  db: DrizzleDb,
  userId: User['id'],
  windowStarts: readonly Date[],
): Promise<RgMoneyRow[]> {
  const earliest = windowStarts.reduce<Date | null>(
    (min, start) => (min === null || start < min ? start : min),
    null,
  );
  if (earliest === null) {
    return [];
  }
  const settledAt = sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;
  const metric = sql<RgMoneyMetric>`case ${walletTransaction.type} when 'deposit' then 'deposits' when 'win' then 'wins' else 'bets' end`;
  const signedAmount = sql`case when ${walletTransaction.type} = 'bet_reversal' then -${walletTransaction.amount} else ${walletTransaction.amount} end`;
  const totals = windowStarts.map(
    (start) => sql`coalesce(sum(${signedAmount}) filter (where ${settledAt} >= ${start}), 0)::text`,
  );
  return db
    .select({
      metric,
      currency: walletTransaction.currency,
      totals: sql<string[]>`array[${sql.join(totals, sql`, `)}]`,
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.status, 'completed'),
        inArray(walletTransaction.type, ['deposit', 'bet', 'bet_reversal', 'win']),
        gte(settledAt, earliest),
      ),
    )
    .groupBy(metric, walletTransaction.currency);
}
