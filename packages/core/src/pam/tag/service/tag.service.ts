import {
  DrizzleService,
  DrizzleTx,
  EventBus,
  findOneOrThrow,
  makeNotFoundError,
  pageToOffset,
  alreadyInUseError,
} from '@openora/core/server';
import { and, asc, count, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  type PlayerTags,
  type Player,
  type TagKey,
  type SortOrder,
} from '@openora/core/contracts';
import type { PlayerTagSortBy } from '../contract/index.js';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag } from '../schema/index.js';
import { mapDbError } from '@openora/core/common/errors';
import { toTag, toPlayerTagWithTag } from './tag-mappers.js';

export const TagNotFoundError = makeNotFoundError('Tag');
export const TagAlreadyInUseError = alreadyInUseError('Tag');
export const TagAssignmentNotFoundError = makeNotFoundError('Tag Assignment');

export class TagService implements PlayerTags {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly event: EventBus,
  ) {}

  // Keyed by auth `userId`, not the internal `player.id`. Users with no active tags are absent from the map.
  public async getActiveTagKeys(userIds: readonly string[]) {
    const result = new Map<string, TagKey[]>();
    if (userIds.length === 0) {
      return result;
    }
    const rows = await this.drizzle.db
      .select({ userId: player.userId, key: tag.key })
      .from(player)
      .innerJoin(playerTag, and(eq(playerTag.playerId, player.id), isNull(playerTag.removedAt)))
      .innerJoin(tag, eq(tag.id, playerTag.tagId))
      .where(inArray(player.userId, [...userIds]));
    for (const row of rows) {
      const keys = result.get(row.userId) ?? [];
      keys.push(row.key);
      result.set(row.userId, keys);
    }
    return result;
  }

  private async _findTagByKeyOrThrow(tagKey: TagKey, trx: DrizzleTx) {
    const results = await trx.select().from(tag).where(eq(tag.key, tagKey)).limit(1);
    return toTag(findOneOrThrow(results, new TagNotFoundError(tagKey)));
  }

  public async createTag(args: CreateTagInput) {
    try {
      const db = this.drizzle.db;
      const [created] = await db.insert(tag).values(args).returning();
      return toTag(created);
    } catch (e) {
      mapDbError(e);
    }
  }

  public async deleteTag(args: DeleteTagInput) {
    try {
      const db = this.drizzle.db;
      await db.delete(tag).where(eq(tag.key, args.key));
      return true;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async listPlayerTags({
    playerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    playerId: Player['id'];
    page: number;
    limit: number;
    sortBy?: PlayerTagSortBy;
    sortOrder?: SortOrder;
  }) {
    const where = and(eq(playerTag.playerId, playerId), isNull(playerTag.removedAt));
    const db = this.drizzle.db;
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const TAG_SORT_COLS = {
      createdAt: playerTag.createdAt,
      assignActor: playerTag.assignActor,
    } as const;
    const tagSortCol = TAG_SORT_COLS[sortBy ?? 'createdAt'];
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({
          pt: playerTag,
          tagKey: tag.key,
        })
        .from(playerTag)
        .innerJoin(tag, eq(playerTag.tagId, tag.id))
        .where(where)
        .orderBy(dir(tagSortCol), desc(playerTag.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(playerTag).where(where),
    ]);
    return {
      items: rows.map((r) => toPlayerTagWithTag(r.pt, r.tagKey)),
      total: Number(n),
      page,
      limit,
    };
  }

  public async listAssignableTags(playerId: Player['id']) {
    const db = this.drizzle.db;
    const rows = await db
      .select()
      .from(tag)
      .where(
        notInArray(
          tag.id,
          db
            .select({ tagId: playerTag.tagId })
            .from(playerTag)
            .where(and(eq(playerTag.playerId, playerId), isNull(playerTag.removedAt))),
        ),
      )
      .orderBy(asc(tag.key));
    return rows.map(toTag);
  }

  public async assignPlayerTag(args: AssignPlayerTagInput) {
    try {
      const { tagKey, ...restArgs } = args;
      const db = this.drizzle.db;
      const result = await db.transaction(async (trx) => {
        const foundTag = await this._findTagByKeyOrThrow(tagKey, trx);
        const [existing] = await trx
          .select()
          .from(playerTag)
          .where(
            and(
              eq(playerTag.tagId, foundTag.id),
              eq(playerTag.playerId, args.playerId),
              isNull(playerTag.removedAt),
            ),
          )
          .limit(1);
        if (existing) {
          throw new TagAlreadyInUseError();
        }
        const [created] = await trx
          .insert(playerTag)
          .values({ ...restArgs, tagId: foundTag.id })
          .returning();
        return toPlayerTagWithTag(created, foundTag.key);
      });
      void this.event.emit('tag.player.assigned', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.assignReason,
        actorId: args.assignActorUserId,
      });
      return result;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async removePlayerTag(args: RemovePlayerTagInput) {
    try {
      const db = this.drizzle.db;
      const result = await db.transaction(async (trx) => {
        const foundTag = await this._findTagByKeyOrThrow(args.tagKey, trx);
        const active = findOneOrThrow(
          await trx
            .select()
            .from(playerTag)
            .where(
              and(
                eq(playerTag.tagId, foundTag.id),
                eq(playerTag.playerId, args.playerId),
                isNull(playerTag.removedAt),
              ),
            )
            .limit(1),
          new TagAssignmentNotFoundError(args.playerId),
        );
        const [updated] = await trx
          .update(playerTag)
          .set({
            removedAt: new Date(),
            removalReason: args.removalReason,
            removalActor: args.removalActor,
            removalActorUserId: args.removalActorUserId,
          })
          .where(eq(playerTag.id, active.id))
          .returning();
        return toPlayerTagWithTag(updated, foundTag.key);
      });
      void this.event.emit('tag.player.removed', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.removalReason,
        actorId: args.removalActorUserId,
      });
      return result;
    } catch (e) {
      mapDbError(e);
    }
  }
}
