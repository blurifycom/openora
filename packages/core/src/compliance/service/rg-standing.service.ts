import type { DrizzleTx } from '@openora/core/server';
import { and, asc, eq, gte, inArray, sql, type SQLWrapper } from 'drizzle-orm';
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
import { pendingChangeStatus } from './rg-eval.js';

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
 * Resolves a limit stored without a currency to the player's own currency for the reading only:
 * the write that fills it in belongs to the limit's own lock (`resolveLimitCurrencyInTx`).
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

/**
 * Completed deposits, stakes net of reversals, and wins per currency, one total per window start.
 * A deposit counts from when it reached the balance: a held deposit from its release. A stake
 * placed before a window and reversed inside it lowers that window's stakes, so a currency's
 * total stops at zero instead of going below it.
 */
export async function readMoneyByWindow(
  tx: DrizzleTx,
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
  const deposits = await readDepositsByWindow(tx, userId, windowStarts, earliest);
  const play = await readPlayByWindow(tx, userId, windowStarts, earliest);
  return [...deposits, ...play];
}

function totalsSince(amount: SQLWrapper, countedAt: SQLWrapper, windowStarts: readonly Date[]) {
  const totals = windowStarts.map(
    (start) =>
      sql`greatest(coalesce(sum(${amount}) filter (where ${countedAt} >= ${start}), 0), 0)::text`,
  );
  return sql<string[]>`array[${sql.join(totals, sql`, `)}]`;
}

async function readDepositsByWindow(
  tx: DrizzleTx,
  userId: User['id'],
  windowStarts: readonly Date[],
  earliest: Date,
): Promise<RgMoneyRow[]> {
  const depositedAt = sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;
  const rows = await tx
    .select({
      currency: walletTransaction.currency,
      totals: totalsSince(walletTransaction.amount, depositedAt, windowStarts),
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.type, 'deposit'),
        eq(walletTransaction.status, 'completed'),
        gte(depositedAt, earliest),
      ),
    )
    .groupBy(walletTransaction.currency);
  return rows.map((row) => ({ ...row, metric: 'deposits' }));
}

// A stake, a reversal or a win is never reviewed: it moved when it was created.
async function readPlayByWindow(
  tx: DrizzleTx,
  userId: User['id'],
  windowStarts: readonly Date[],
  earliest: Date,
): Promise<RgMoneyRow[]> {
  const metric = sql<RgMoneyMetric>`case ${walletTransaction.type} when 'win' then 'wins' else 'bets' end`;
  const signedAmount = sql`case when ${walletTransaction.type} = 'bet_reversal' then -${walletTransaction.amount} else ${walletTransaction.amount} end`;
  return tx
    .select({
      metric,
      currency: walletTransaction.currency,
      totals: totalsSince(signedAmount, walletTransaction.createdAt, windowStarts),
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.status, 'completed'),
        inArray(walletTransaction.type, ['bet', 'bet_reversal', 'win']),
        gte(walletTransaction.createdAt, earliest),
      ),
    )
    .groupBy(metric, walletTransaction.currency);
}
