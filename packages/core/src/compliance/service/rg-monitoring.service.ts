import { DrizzleService, pageToOffset } from '@openora/core/server';
import { and, eq, or, gt, gte, lte, isNull, desc, sql, type SQL } from 'drizzle-orm';
import type { AdminUserDirectory, LimitType, LimitPeriod } from '@openora/core/contracts';
import { userLimit, rgFlag, rgExclusion } from '../schema/index.js';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { gameRound } from '@openora/core/casino/schema/gaming';
import { session } from '@openora/core/pam/schema/identity';
import type { RgFlagListItem, ListRgFlagsInput, RgFlagDetail } from '../contract/index.js';
import { periodWindow, isAtThreshold, thresholdPct } from './rg-eval.js';

// The recompute trigger carried on the enqueued job - which upstream event fired.
export type RgEvalTrigger =
  | 'wallet.deposit.completed'
  | 'gaming.round.ended'
  | 'rg.exclusion.login_blocked';

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

  async evaluateUser(userId: string, trigger: RgEvalTrigger): Promise<void> {
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
      if (limit.period === 'session' || limit.type === 'session') continue;
      const { from } = periodWindow(limit.period as LimitPeriod, now);
      const actual = await this.spendFor(userId, limit.type as LimitType, from, now);
      if (isAtThreshold(actual, limit.amount)) {
        await this.raiseFlag(userId, 'limit_threshold', limit.type, {
          actual,
          limit: limit.amount,
          period: limit.period as LimitPeriod,
          pct: thresholdPct(actual, limit.amount),
        });
      } else {
        await this.clearFlag(userId, 'limit_threshold', limit.type);
      }
    }
  }

  // Recurring session-time sweep: raises session_time flags for players whose current
  // active session is at >= 80% of their configured session-minute limit, and clears
  // flags for players who have since ended or rolled over their session.
  async sweep(): Promise<void> {
    const now = new Date();
    const sessionLimits = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(
        and(eq(userLimit.type, SESSION_LIMIT.type), eq(userLimit.period, SESSION_LIMIT.period)),
      );

    for (const limit of sessionLimits) {
      const [longest] = await this.drizzle.db
        .select({ createdAt: session.createdAt })
        .from(session)
        .where(and(eq(session.userId, limit.userId), gt(session.expiresAt, now)))
        .orderBy(session.createdAt)
        .limit(1);

      const elapsedMinutes = longest ? (now.getTime() - longest.createdAt.getTime()) / 60000 : 0;

      if (longest && isAtThreshold(elapsedMinutes, limit.amount)) {
        await this.raiseFlag(limit.userId, 'session_time', null, {
          sessionMinutes: elapsedMinutes,
          limitMinutes: limit.amount,
          pct: thresholdPct(elapsedMinutes, limit.amount),
        });
      } else {
        await this.clearFlag(limit.userId, 'session_time', null);
      }
    }
  }

  async listFlags(filters: ListRgFlagsInput) {
    const db = this.drizzle.db;
    const { page, limit, flagType, limitType, status, fromDate, toDate } = filters;
    const offset = pageToOffset(page, limit);

    const conditions: SQL[] = [];
    if (flagType) conditions.push(eq(rgFlag.flagType, flagType));
    if (limitType) conditions.push(eq(rgFlag.limitType, limitType));
    if (status) conditions.push(eq(rgFlag.status, status));
    if (fromDate) conditions.push(gte(rgFlag.flaggedAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(rgFlag.flaggedAt, new Date(toDate)));
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

  private async spendFor(userId: string, type: LimitType, from: Date, to: Date): Promise<number> {
    if (type === 'deposit') return this.depositsSum(userId, from, to);
    return this.betsSum(userId, from, to);
  }

  private async depositsSum(userId: string, from: Date, to: Date): Promise<number> {
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
    return Number(row?.total ?? 0);
  }

  private async betsSum(userId: string, from: Date, to: Date): Promise<number> {
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
    return Number(rounds?.total ?? 0);
  }

  private async raiseFlag(
    userId: string,
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
    userId: string,
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
