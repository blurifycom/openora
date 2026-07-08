import {
  DrizzleService,
  DrizzleTx,
  EventBus,
  makeNotFoundError,
  pageToOffset,
  alreadyInUseError,
} from '@blurifycom/core/server';
import { and, asc, count, eq, isNull, notInArray } from 'drizzle-orm';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  Tag,
  type TagKey,
} from '@blurifycom/core/contracts';
import { playerTag, tag } from '../schema/index.js';
import { PlayerTagWithTag } from '../contract/index.js';
import { mapDbError } from '@blurifycom/core/common/errors';
import { toTag, toPlayerTagWithTag } from './tag-mappers.js';

export const TagNotFoundError = makeNotFoundError('Tag');
export const TagAlreadyInUseError = alreadyInUseError('Tag');
export const TagAssignmentNotFoundError = makeNotFoundError('Tag Assignment');

export class TagService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly event: EventBus,
  ) {}

  private async _findTagByKeyOrThrow(tagKey: TagKey, trx: DrizzleTx): Promise<Tag> {
    const results = await trx.select().from(tag).where(eq(tag.key, tagKey)).limit(1);
    if (!results.length) {
      throw new TagNotFoundError(tagKey);
    }
    return toTag(results[0]);
  }

  public async createTag(args: CreateTagInput): Promise<Tag> {
    try {
      const db = this.drizzle.db;
      const [created] = await db.insert(tag).values(args).returning();
      return toTag(created);
    } catch (e) {
      mapDbError(e);
    }
  }

  public async deleteTag(args: DeleteTagInput): Promise<boolean> {
    try {
      const db = this.drizzle.db;
      await db.delete(tag).where(eq(tag.key, args.key));
      return true;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async listPlayerTags(playerId: string, page: number, limit: number) {
    const where = and(eq(playerTag.playerId, playerId), isNull(playerTag.removedAt));
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({
          pt: playerTag,
          tagKey: tag.key,
        })
        .from(playerTag)
        .innerJoin(tag, eq(playerTag.tagId, tag.id))
        .where(where)
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

  public async listAssignableTags(playerId: string): Promise<Tag[]> {
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

  public async assignPlayerTag(args: AssignPlayerTagInput): Promise<PlayerTagWithTag> {
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

  public async removePlayerTag(args: RemovePlayerTagInput): Promise<PlayerTagWithTag> {
    try {
      const db = this.drizzle.db;
      const result = await db.transaction(async (trx) => {
        const foundTag = await this._findTagByKeyOrThrow(args.tagKey, trx);
        const [active] = await trx
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
        if (!active) {
          throw new TagAssignmentNotFoundError(args.playerId);
        }
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
