import { DrizzleService } from '@openora/core/server';
import {
  MAX_PLAYER_SEGMENT_PAGE,
  UuidSchema,
  type Player,
  type PlayerSegmentPage,
  type PlayerSegmentQuery,
  type PlayerSegmentReader,
} from '@openora/core/contracts';
import { type SQL, and, asc, eq, exists, gt, inArray, isNull, ne } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag } from '../schema/index.js';

// The one definition of the population (see PlayerSegmentReader): a staff login can carry a
// player profile too, so the role is checked as well as the profile.
const inPopulation = (): SQL | undefined =>
  and(eq(user.role, 'player'), ne(player.status, 'closed'));

const isUuid = (id: string) => UuidSchema.safeParse(id).success;

export class PlayerSegmentReaderService implements PlayerSegmentReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async page({ tags = [], after, limit }: PlayerSegmentQuery): Promise<PlayerSegmentPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PLAYER_SEGMENT_PAGE) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_PLAYER_SEGMENT_PAGE}`);
    }
    if (after !== undefined && !isUuid(after)) {
      throw new RangeError('after must be the player id a previous page returned as next');
    }
    const db = this.drizzle.db;
    const holdsAnyTag =
      tags.length === 0
        ? undefined
        : exists(
            db
              .select({ id: playerTag.id })
              .from(playerTag)
              .innerJoin(tag, eq(tag.id, playerTag.tagId))
              .where(
                and(
                  eq(playerTag.playerId, player.id),
                  isNull(playerTag.removedAt),
                  inArray(tag.key, [...new Set(tags)]),
                ),
              ),
          );
    // One row past the page says whether another page follows.
    const rows = await db
      .select({ id: player.id })
      .from(player)
      .innerJoin(user, eq(user.id, player.userId))
      .where(
        and(inPopulation(), after === undefined ? undefined : gt(player.id, after), holdsAnyTag),
      )
      .orderBy(asc(player.id))
      .limit(limit + 1);
    const playerIds = rows.slice(0, limit).map((row) => row.id);
    return { playerIds, next: rows.length > limit ? (playerIds.at(-1) ?? null) : null };
  }

  async resolve(
    ref: { playerIds: readonly string[] } | { userIds: readonly string[] },
  ): Promise<Map<string, Player['id']>> {
    const byUserId = 'userIds' in ref;
    const given = byUserId ? ref.userIds : ref.playerIds;
    if (given.length > MAX_PLAYER_SEGMENT_PAGE) {
      throw new RangeError(`resolve takes at most ${MAX_PLAYER_SEGMENT_PAGE} ids`);
    }
    const resolved = new Map<string, Player['id']>();
    const ids = [...new Set(given)].filter(isUuid);
    if (ids.length === 0) {
      return resolved;
    }
    const key = byUserId ? player.userId : player.id;
    const rows = await this.drizzle.db
      .select({ key, id: player.id })
      .from(player)
      .innerJoin(user, eq(user.id, player.userId))
      .where(and(inPopulation(), inArray(key, ids)));
    for (const row of rows) {
      resolved.set(row.key, row.id);
    }
    return resolved;
  }
}
