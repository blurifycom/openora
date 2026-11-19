import { and, count, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import {
  dayEnd,
  dayStart,
  normalizeKycStatus,
  type KycStatus,
  type TagKey,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag } from '@openora/core/pam/schema/tag';
import type { PlayersFind, PlayersFindInput, PlayersFindSortBy } from '../contract/index.js';

const SORT_COLUMNS: Record<PlayersFindSortBy, SQL> = {
  registeredAt: sql`${player.createdAt}`,
  lastSeenAt: sql`${player.lastSeenAt}`,
  totalDeposits: sql`${player.totalDeposits}`,
  totalWagered: sql`${player.totalWagered}`,
};

/** A KYC status filter that also matches the legacy `verified` rows an `approved` one means. */
function kycStatusesMatching(statuses: readonly KycStatus[]): KycStatus[] {
  const normalized = new Set(statuses.map(normalizeKycStatus));
  return normalized.has('approved') ? [...normalized, 'verified'] : [...normalized];
}

/**
 * Finds players by account facts an operator filters on, for an agent: no identity data, so it
 * reads the player profile alone and never the user table.
 */
export class PlayersFindService {
  constructor(private readonly drizzle: DrizzleService) {}

  async find({
    status,
    kycStatus,
    country,
    currency,
    tagKeys,
    registeredFrom,
    registeredTo,
    lastSeenFrom,
    lastSeenTo,
    minTotalDeposits,
    sortBy,
    sortDir,
    limit,
  }: PlayersFindInput): Promise<PlayersFind> {
    const db = this.drizzle.db;
    const requiredTags = [...new Set(tagKeys)];
    const where = and(
      status?.length ? inArray(player.status, status) : undefined,
      kycStatus?.length ? inArray(player.kycStatus, kycStatusesMatching(kycStatus)) : undefined,
      country ? sql`upper(${player.country}) = ${country.toUpperCase()}` : undefined,
      currency ? eq(player.currency, currency.toUpperCase()) : undefined,
      requiredTags.length > 0
        ? inArray(
            player.id,
            db
              .select({ playerId: playerTag.playerId })
              .from(playerTag)
              .innerJoin(tag, eq(tag.id, playerTag.tagId))
              .where(and(inArray(tag.key, requiredTags), isNull(playerTag.removedAt)))
              .groupBy(playerTag.playerId)
              .having(sql`count(distinct ${tag.key}) = ${requiredTags.length}`),
          )
        : undefined,
      registeredFrom ? gte(player.createdAt, dayStart(registeredFrom)) : undefined,
      registeredTo ? lte(player.createdAt, dayEnd(registeredTo)) : undefined,
      lastSeenFrom ? gte(player.lastSeenAt, dayStart(lastSeenFrom)) : undefined,
      lastSeenTo ? lte(player.lastSeenAt, dayEnd(lastSeenTo)) : undefined,
      minTotalDeposits ? gte(player.totalDeposits, minTotalDeposits) : undefined,
    );
    const direction = sql.raw(sortDir);
    const [rows, totals] = await Promise.all([
      db
        .select({
          playerId: player.id,
          status: player.status,
          kycStatus: player.kycStatus,
          country: player.country,
          currency: player.currency,
          level: player.level,
          registeredAt: player.createdAt,
          lastSeenAt: player.lastSeenAt,
          totalDeposits: player.totalDeposits,
          totalWagered: player.totalWagered,
        })
        .from(player)
        .where(where)
        // The player id breaks ties, so equal figures always list in the same order.
        .orderBy(
          sql`${SORT_COLUMNS[sortBy]} ${direction} nulls last`,
          sql`${player.id} ${direction}`,
        )
        .limit(limit + 1),
      db.select({ total: count() }).from(player).where(where),
    ]);
    const page = rows.slice(0, limit);
    const tagsOf = await this.activeTagKeys(page.map((row) => row.playerId));
    return {
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      players: page.map((row) => ({
        ...row,
        kycStatus: normalizeKycStatus(row.kycStatus),
        registeredAt: row.registeredAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        tagKeys: tagsOf.get(row.playerId) ?? [],
      })),
    };
  }

  /** The tag keys each of `playerIds` holds now, alphabetical. */
  private async activeTagKeys(playerIds: readonly string[]): Promise<Map<string, TagKey[]>> {
    if (playerIds.length === 0) {
      return new Map();
    }
    const held = await this.drizzle.db
      .select({ playerId: playerTag.playerId, key: tag.key })
      .from(playerTag)
      .innerJoin(tag, eq(tag.id, playerTag.tagId))
      .where(and(inArray(playerTag.playerId, [...playerIds]), isNull(playerTag.removedAt)))
      .orderBy(sql`${tag.key}::text`);
    const byPlayer = new Map<string, TagKey[]>();
    for (const { playerId, key } of held) {
      byPlayer.set(playerId, [...(byPlayer.get(playerId) ?? []), key]);
    }
    return byPlayer;
  }
}
