import {
  DrizzleService,
  createLogger,
  pageToOffset,
  moneyAdd,
  moneyToNumber,
  mapConcurrent,
  type DrizzleDb,
  type DrizzleTx,
} from '@openora/core/server';
import { and, eq, or, gt, gte, lte, isNull, inArray, asc, desc, sql, type SQL } from 'drizzle-orm';
import type {
  AdminUserDirectory,
  ExchangeRateReader,
  LimitType,
  LimitPeriod,
  User,
} from '@openora/core/contracts';
import { userLimit, rgFlag, rgExclusion } from '../schema/index.js';
import { resolveLimitCurrency, RgLimitCurrencyUnresolvedError } from './rg.service.js';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { gameRound } from '@openora/core/casino/schema/gaming';
import { session } from '@openora/core/pam/schema/identity';
import type { RgFlagListItem, ListRgFlagsInput, RgFlagDetail } from '../contract/index.js';
import { periodWindow, isAtThreshold, thresholdPct } from './rg-eval.js';

const logger = createLogger('compliance-rg-monitoring');

export class RgRateUnavailableError extends Error {
  constructor(
    readonly limitType: LimitType,
    readonly period: LimitPeriod,
    readonly missingCurrency: string,
    readonly limitCurrency: string,
  ) {
    super(
      `No exchange rate available to convert ${missingCurrency} into ${limitCurrency} for the ${period} ${limitType} limit`,
    );
    this.name = 'RgRateUnavailableError';
  }
}

// The recompute trigger carried on the enqueued job - which upstream event fired.
export const RG_EVAL_TRIGGERS = [
  'wallet.deposit.completed',
  'gaming.round.ended',
  'rg.exclusion.login_blocked',
  'rg.limit.set',
] as const;
export type RgEvalTrigger = (typeof RG_EVAL_TRIGGERS)[number];

const SESSION_LIMIT = { type: 'session', period: 'session' } as const;

// Cap in-flight flag writes per sweep so a large session-limit population can't exhaust the
// shared pg pool. ponytail: fixed cap; raise only if a single sweep can't keep up.
const SWEEP_CONCURRENCY = 10;

export type RgMonitoringDeps = {
  drizzle: DrizzleService;
  directory?: AdminUserDirectory | null;
  rates: ExchangeRateReader;
};

export class RgMonitoringService {
  private readonly drizzle: DrizzleService;
  private readonly directory: AdminUserDirectory | null;
  private readonly rates: ExchangeRateReader;

  constructor(deps: RgMonitoringDeps) {
    this.drizzle = deps.drizzle;
    this.directory = deps.directory ?? null;
    this.rates = deps.rates;
  }

  async evaluateUser(userId: User['id'], trigger: RgEvalTrigger) {
    const now = new Date();
    if (trigger === 'rg.exclusion.login_blocked') {
      // Label the flag with the exclusion kind so dashboards distinguish a cooling-off
      // login attempt from a self-exclusion one.
      const active = await this.drizzle.db
        .select({ kind: rgExclusion.kind })
        .from(rgExclusion)
        .where(
          and(
            eq(rgExclusion.userId, userId),
            eq(rgExclusion.status, 'active'),
            or(eq(rgExclusion.kind, 'self_exclusion'), gt(rgExclusion.expiresAt, now)),
          ),
        );
      const kind = active.some((e) => e.kind === 'self_exclusion')
        ? 'self_exclusion'
        : (active[0]?.kind ?? null);
      await this.raiseFlag(userId, 'self_excluded_login', null, { trigger, kind });
      return;
    }
    const limits = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(eq(userLimit.userId, userId));

    for (const limit of limits) {
      // Money-type limits only (deposit/wager/loss); the session-type limit is handled by sweep().
      if (limit.period === 'session' || limit.type === 'session' || limit.amount === null) {
        continue;
      }
      const limitAmount = limit.amount;
      const { from } = periodWindow(limit.period as LimitPeriod, now);
      let actualAmount: string;
      try {
        const limitCurrency = (await resolveLimitCurrency(this.drizzle, limit)).currency;
        actualAmount = await this.spendFor(
          this.drizzle.db,
          userId,
          limit.type as LimitType,
          limit.period as LimitPeriod,
          from,
          limitCurrency,
        );
      } catch (err) {
        if (
          !(err instanceof RgRateUnavailableError) &&
          !(err instanceof RgLimitCurrencyUnresolvedError)
        ) {
          throw err;
        }
        logger.warn(
          { err, userId, limitType: limit.type },
          'RG flag evaluation skipped: rate or currency missing',
        );
        continue;
      }
      // Threshold comparison is a review-flag decision, not a ledger write - moneyToNumber
      // is the documented single conversion point (see the helper's own doc comment).
      if (isAtThreshold(moneyToNumber(actualAmount), moneyToNumber(limitAmount))) {
        await this.raiseFlag(userId, 'limit_threshold', limit.type, {
          actual: actualAmount,
          limit: limitAmount,
          period: limit.period as LimitPeriod,
          pct: thresholdPct(moneyToNumber(actualAmount), moneyToNumber(limitAmount)),
        });
      } else {
        await this.clearFlag(userId, 'limit_threshold', limit.type);
      }
    }
  }

  // Recurring session-time sweep: raises session_time flags for players whose current
  // active session is at >= 80% of their configured session-minute limit, and clears
  // flags for players who have since ended or rolled over their session.
  async sweep() {
    const now = new Date();
    const sessionLimits = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(
        and(eq(userLimit.type, SESSION_LIMIT.type), eq(userLimit.period, SESSION_LIMIT.period)),
      );

    const userIds = sessionLimits.map((l) => l.userId);
    const activeSessions = userIds.length
      ? await this.drizzle.db
          .select({ userId: session.userId, createdAt: session.createdAt })
          .from(session)
          .where(and(inArray(session.userId, userIds), gt(session.expiresAt, now)))
      : [];

    const earliestByUser = new Map<User['id'], Date>();
    for (const s of activeSessions) {
      const current = earliestByUser.get(s.userId);
      if (!current || s.createdAt < current) {
        earliestByUser.set(s.userId, s.createdAt);
      }
    }

    const pending = sessionLimits.filter((limit) => limit.minutes !== null);
    await mapConcurrent(pending, SWEEP_CONCURRENCY, (limit) => {
      const limitMinutes = limit.minutes as number;
      const longest = earliestByUser.get(limit.userId) ?? null;
      const elapsedMinutes = longest ? (now.getTime() - longest.getTime()) / 60000 : 0;

      if (longest && isAtThreshold(elapsedMinutes, limitMinutes)) {
        return this.raiseFlag(limit.userId, 'session_time', null, {
          sessionMinutes: elapsedMinutes,
          limitMinutes,
          pct: thresholdPct(elapsedMinutes, limitMinutes),
        });
      }
      return this.clearFlag(limit.userId, 'session_time', null);
    });
  }

  async listFlags(filters: ListRgFlagsInput) {
    const db = this.drizzle.db;
    const { page, limit, flagType, limitType, status, fromDate, toDate, sortBy, sortOrder } =
      filters;
    const offset = pageToOffset(page, limit);
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const RG_SORT_COLS = {
      flaggedAt: rgFlag.flaggedAt,
      limitType: rgFlag.limitType,
      flagType: rgFlag.flagType,
      status: rgFlag.status,
      clearedAt: rgFlag.clearedAt,
      userId: rgFlag.userId,
    } as const;

    const conditions: SQL[] = [];
    if (flagType) {
      conditions.push(eq(rgFlag.flagType, flagType));
    }
    if (limitType) {
      conditions.push(eq(rgFlag.limitType, limitType));
    }
    if (status) {
      conditions.push(eq(rgFlag.status, status));
    }
    if (fromDate) {
      conditions.push(gte(rgFlag.flaggedAt, new Date(fromDate)));
    }
    if (toDate) {
      conditions.push(lte(rgFlag.flaggedAt, new Date(toDate)));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(rgFlag)
        .where(where)
        .orderBy(dir(RG_SORT_COLS[sortBy ?? 'flaggedAt']), desc(rgFlag.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(rgFlag)
        .where(where),
    ]);

    const summaries = this.directory
      ? await this.directory.lookupPlayers(rows.map((r) => r.userId))
      : [];
    const byId = new Map(summaries.map((s) => [s.userId, s]));

    const items: RgFlagListItem[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      username: byId.get(r.userId)?.username ?? null,
      email: byId.get(r.userId)?.email ?? null,
      flagType: r.flagType,
      limitType: r.limitType,
      detail: r.detail,
      status: r.status,
      flaggedAt: r.flaggedAt.toISOString(),
      clearedAt: r.clearedAt ? r.clearedAt.toISOString() : null,
    }));

    return { items, total: countResult[0]?.count ?? 0, page, limit };
  }

  /**
   * Spend counted against one money limit inside its period window, converted into
   * `limitCurrency` and returned as a decimal string. Throws `RgRateUnavailableError`
   * when a source currency has no available conversion rate, rather than treating that
   * group as zero.
   */
  async spendFor(
    db: DrizzleDb | DrizzleTx,
    userId: User['id'],
    type: LimitType,
    period: LimitPeriod,
    from: Date,
    limitCurrency: string,
  ) {
    if (type === 'deposit') {
      return this.convertedTotal(
        await this.depositsByCurrency(db, userId, from),
        type,
        period,
        limitCurrency,
      );
    }
    if (type === 'loss') {
      return this.convertedTotal(
        await this.netLossByCurrency(db, userId, from),
        type,
        period,
        limitCurrency,
      );
    }
    return this.convertedTotal(
      await this.betsByCurrency(db, userId, from),
      type,
      period,
      limitCurrency,
    );
  }

  private async convertedTotal(
    groups: { currency: string; total: string }[],
    type: LimitType,
    period: LimitPeriod,
    limitCurrency: string,
  ): Promise<string> {
    let total = '0';
    for (const group of groups) {
      if (group.currency === limitCurrency) {
        total = moneyAdd(total, group.total);
        continue;
      }
      const converted = await this.rates.convert(group.total, group.currency, limitCurrency);
      if (converted === null) {
        throw new RgRateUnavailableError(type, period, group.currency, limitCurrency);
      }
      total = moneyAdd(total, converted);
    }
    return total;
  }

  private async depositsByCurrency(db: DrizzleDb | DrizzleTx, userId: User['id'], from: Date) {
    return db
      .select({
        currency: walletTransaction.currency,
        total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          // A pending deposit is a reservation the wallet took under the player's deposit
          // lock before charging the PSP. Counting it is what stops two concurrent deposits
          // from spending the same headroom; it is released to `failed` if the charge fails.
          inArray(walletTransaction.status, ['completed', 'pending']),
          gte(walletTransaction.createdAt, from),
          // The database stamps createdAt, so the upper bound reads the same clock. An
          // app-side new Date() that trails the database by a millisecond would drop a
          // just-committed deposit out of the player's spend.
          lte(walletTransaction.createdAt, sql`now()`),
        ),
      )
      .groupBy(walletTransaction.currency);
  }

  private async betsByCurrency(db: DrizzleDb | DrizzleTx, userId: User['id'], from: Date) {
    return db
      .select({
        currency: gameRound.currency,
        total: sql<string>`coalesce(sum(${gameRound.betAmount}), 0)`,
      })
      .from(gameRound)
      .where(and(eq(gameRound.userId, userId), gte(gameRound.startedAt, from)))
      .groupBy(gameRound.currency);
  }

  private async netLossByCurrency(db: DrizzleDb | DrizzleTx, userId: User['id'], from: Date) {
    return db
      .select({
        currency: gameRound.currency,
        total: sql<string>`greatest(coalesce(sum(${gameRound.betAmount} - ${gameRound.winAmount}), 0), 0)`,
      })
      .from(gameRound)
      .where(and(eq(gameRound.userId, userId), gte(gameRound.startedAt, from)))
      .groupBy(gameRound.currency);
  }

  clearLimitThresholdFlag(userId: User['id'], limitType: string): Promise<void> {
    return this.clearFlag(userId, 'limit_threshold', limitType);
  }

  private async raiseFlag(
    userId: User['id'],
    flagType: (typeof rgFlag.$inferSelect)['flagType'],
    limitType: string | null,
    detail: RgFlagDetail,
  ): Promise<void> {
    const [existing] = await this.drizzle.db
      .select({ id: rgFlag.id })
      .from(rgFlag)
      .where(
        and(
          eq(rgFlag.userId, userId),
          eq(rgFlag.flagType, flagType),
          eq(rgFlag.status, 'active'),
          limitType === null ? isNull(rgFlag.limitType) : eq(rgFlag.limitType, limitType),
        ),
      )
      .limit(1);

    if (existing) {
      await this.drizzle.db.update(rgFlag).set({ detail }).where(eq(rgFlag.id, existing.id));
      return;
    }
    await this.drizzle.db.insert(rgFlag).values({ userId, flagType, limitType, detail });
  }

  private async clearFlag(
    userId: User['id'],
    flagType: (typeof rgFlag.$inferSelect)['flagType'],
    limitType: string | null,
  ): Promise<void> {
    await this.drizzle.db
      .update(rgFlag)
      .set({ status: 'cleared', clearedAt: new Date() })
      .where(
        and(
          eq(rgFlag.userId, userId),
          eq(rgFlag.flagType, flagType),
          eq(rgFlag.status, 'active'),
          limitType === null ? isNull(rgFlag.limitType) : eq(rgFlag.limitType, limitType),
        ),
      );
  }
}
