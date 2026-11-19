import { and, asc, count, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import { dayEnd, dayStart } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import type { GrantsFind, GrantsFindInput } from '../contract/index.js';
import { promoGrant } from '../schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ['pending', 'active'] as const;

const grant = promoGrant;

/** Finds bonus grants across all players, each by player id and without the admin's note. */
export class GrantsFindService {
  constructor(private readonly drizzle: DrizzleService) {}

  async find(
    {
      status,
      source,
      playerId,
      currency,
      activatedFrom,
      activatedTo,
      expiringWithinDays,
      limit,
    }: GrantsFindInput,
    now = new Date(),
  ): Promise<GrantsFind> {
    const db = this.drizzle.db;
    const where = and(
      status?.length ? inArray(grant.status, status) : undefined,
      source?.length ? inArray(grant.source, source) : undefined,
      playerId
        ? inArray(
            grant.userId,
            db.select({ userId: player.userId }).from(player).where(eq(player.id, playerId)),
          )
        : undefined,
      currency ? eq(grant.currency, currency.toUpperCase()) : undefined,
      activatedFrom ? gte(grant.activatedAt, dayStart(activatedFrom)) : undefined,
      activatedTo ? lte(grant.activatedAt, dayEnd(activatedTo)) : undefined,
      ...(expiringWithinDays
        ? [
            inArray(grant.status, [...LIVE_STATUSES]),
            gte(grant.expiresAt, now),
            lte(grant.expiresAt, new Date(now.getTime() + expiringWithinDays * DAY_MS)),
          ]
        : []),
    );
    // The grant id breaks ties, so equal times always list in the same order.
    const order = expiringWithinDays
      ? [asc(grant.expiresAt), asc(grant.id)]
      : [desc(grant.createdAt), desc(grant.id)];
    const [rows, totals] = await Promise.all([
      db
        .select({
          grantId: grant.id,
          playerId: player.id,
          status: grant.status,
          source: grant.source,
          currency: grant.currency,
          grantedAmount: grant.grantedAmount,
          bonusBalance: grant.bonusBalance,
          wageringRequired: grant.wageringRequired,
          wageringProgress: grant.wageringProgress,
          activatedAt: grant.activatedAt,
          expiresAt: grant.expiresAt,
          closedAt: grant.closedAt,
          forfeitReason: grant.forfeitReason,
        })
        .from(grant)
        .leftJoin(player, eq(player.userId, grant.userId))
        .where(where)
        .orderBy(...order)
        .limit(limit + 1),
      db.select({ total: count() }).from(grant).where(where),
    ]);
    return {
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      grants: rows.slice(0, limit).map((row) => ({
        ...row,
        activatedAt: row.activatedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
      })),
    };
  }
}
