import { DrizzleService, pageToOffset, moneyToNumber } from '@openora/core/server';
import { and, eq, or, gt, gte, lte, isNull, inArray, desc, sql, type SQL } from 'drizzle-orm';
import type { AdminUserDirectory, LimitType, LimitPeriod, User } from '@openora/core/contracts';
import { userLimit, rgFlag, rgExclusion } from '../schema/index.js';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { gameRound } from '@openora/core/casino/schema/gaming';
import { session } from '@openora/core/pam/schema/identity';
import type { RgFlagListItem, ListRgFlagsInput, RgFlagDetail } from '../contract/index.js';
import { periodWindow, isAtThreshold, thresholdPct } from './rg-eval.js';

// The recompute trigger carried on the enqueued job - which upstream event fired.
export const RG_EVAL_TRIGGERS = [
  'wallet.deposit.completed',
  'gaming.round.ended',
  'rg.exclusion.login_blocked',
] as const;
export type RgEvalTrigger = (typeof RG_EVAL_TRIGGERS)[number];

const SESSION_LIMIT = { type: 'session', period: 'session' } as const;

export type RgMonitoringDeps = {
  drizzle: DrizzleService;
  directory?: AdminUserDirectory | null;
};

export class RgMonitoringService {
  private readonly drizzle: DrizzleService;
  private readonly directory: AdminUserDirectory | null;

  constructor(deps: RgMonitoringDeps) {
    this.drizzle = deps.drizzle;
    this.directory = deps.directory ?? null;
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
      const actualAmount = await this.spendFor(userId, limit.type as LimitType, from, now);
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

    await Promise.all(
      sessionLimits
        .filter((limit) => limit.minutes !== null)
        .map((limit) => {
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
        }),
    );
  }

  async listFlags(filters: ListRgFlagsInput) {
    const db = this.drizzle.db;
    const { page, limit, flagType, limitType, status, fromDate, toDate } = filters;
    const offset = pageToOffset(page, limit);

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
        .orderBy(desc(rgFlag.flaggedAt))
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

  private async spendFor(userId: User['id'], type: LimitType, from: Date, to: Date) {
    if (type === 'deposit') {
      return this.depositsSum(userId, from, to);
    }
    return this.betsSum(userId, from, to);
  }

  // Decimal string, matching userLimit.amount (same unit as walletTransaction.amount).
  private async depositsSum(userId: User['id'], from: Date, to: Date) {
    const [row] = await this.drizzle.db
      .select({ total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)` })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
          gte(walletTransaction.createdAt, from),
          lte(walletTransaction.createdAt, to),
        ),
      );
    return row?.total ?? '0';
  }

  // Decimal string, matching userLimit.amount (same unit as gameRound.betAmount).
  private async betsSum(userId: User['id'], from: Date, to: Date) {
    const [rounds] = await this.drizzle.db
      .select({ total: sql<string>`coalesce(sum(${gameRound.betAmount}), 0)` })
      .from(gameRound)
      .where(
        and(
          eq(gameRound.userId, userId),
          gte(gameRound.startedAt, from),
          lte(gameRound.startedAt, to),
        ),
      );
    return rounds?.total ?? '0';
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
