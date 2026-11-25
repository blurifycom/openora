import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import {
  dayEnd,
  dayStart,
  userIdOfPlayer,
  withPlayerIds,
  type IdentityReader,
} from '@openora/core/contracts';
import type { GrantsFind, GrantsFindInput } from '../contract/index.js';
import { promoGrant } from '../schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ['pending', 'active'] as const;

const grant = promoGrant;

/** Finds bonus grants across all players, each by player id and without the admin's note. */
export class GrantsFindService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly identity: IdentityReader,
  ) {}

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
    // The player id names a user through IDENTITY_READER; an unknown one matches nothing.
    const playerUserId = playerId ? await userIdOfPlayer(this.identity, playerId) : null;
    const where = and(
      status?.length ? inArray(grant.status, status) : undefined,
      source?.length ? inArray(grant.source, source) : undefined,
      playerId ? (playerUserId === null ? sql`false` : eq(grant.userId, playerUserId)) : undefined,
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
          userId: grant.userId,
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
        .where(where)
        .orderBy(...order)
        .limit(limit + 1),
      db.select({ total: count() }).from(grant).where(where),
    ]);
    return {
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      grants: (await withPlayerIds(this.identity, rows.slice(0, limit))).map((row) => ({
        ...row,
        activatedAt: row.activatedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
      })),
    };
  }
}
