import { and, asc, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { tagKeys as TAG_KEYS } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  SEGMENT_MAX_LEVELS,
  type SegmentCounts,
  type SegmentCountsInput,
} from '../contract/index.js';
import { inPopulation } from '../adapters/player-segment-reader.service.js';
import { playerTag, tag } from '../schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * players.segment_counts: the population, each tag's players and each account level's, and how
 * many of each were seen over the window - over the population PlayerSegmentReader pages.
 */
export class SegmentCountsService {
  constructor(private readonly drizzle: DrizzleService) {}

  async counts(
    { tagKeys = [...TAG_KEYS], windowDays }: SegmentCountsInput,
    now = new Date(),
  ): Promise<SegmentCounts> {
    const db = this.drizzle.db;
    const seen = gte(player.lastSeenAt, new Date(now.getTime() - windowDays * DAY_MS));
    const players = sql<number>`count(distinct ${player.id})`.mapWith(Number);
    const seenPlayers = sql<number>`count(distinct ${player.id}) filter (where ${seen})`.mapWith(
      Number,
    );
    const [[population], tagRows, levelRows] = await Promise.all([
      db
        .select({ players: count(), seenInWindow: seenPlayers })
        .from(player)
        .innerJoin(user, eq(user.id, player.userId))
        .where(inPopulation()),
      db
        .select({ tag: tag.key, players, seenInWindow: seenPlayers })
        .from(playerTag)
        .innerJoin(tag, eq(tag.id, playerTag.tagId))
        .innerJoin(player, eq(player.id, playerTag.playerId))
        .innerJoin(user, eq(user.id, player.userId))
        .where(and(inArray(tag.key, tagKeys), isNull(playerTag.removedAt), inPopulation()))
        .groupBy(tag.key),
      db
        .select({ level: player.level, players, seenInWindow: seenPlayers })
        .from(player)
        .innerJoin(user, eq(user.id, player.userId))
        .where(inPopulation())
        .groupBy(player.level)
        .orderBy(asc(player.level))
        .limit(SEGMENT_MAX_LEVELS + 1),
    ]);
    const byTag = new Map(tagRows.map((row) => [row.tag, row]));
    return {
      windowDays,
      population: {
        players: Number(population?.players ?? 0),
        seenInWindow: population?.seenInWindow ?? 0,
      },
      tags: tagKeys.map((key) => ({
        tag: key,
        players: byTag.get(key)?.players ?? 0,
        seenInWindow: byTag.get(key)?.seenInWindow ?? 0,
      })),
      levels: levelRows.slice(0, SEGMENT_MAX_LEVELS),
      truncated: levelRows.length > SEGMENT_MAX_LEVELS,
    };
  }
}
