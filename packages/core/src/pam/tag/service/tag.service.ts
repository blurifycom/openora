import {
  DrizzleService,
  DrizzleTx,
  EventBus,
  makeNotFoundError,
  pageToOffset,
} from '@blurifycom/core/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  Tag,
} from '@blurifycom/core/contracts';
import { playerTag, tag } from '../schema/index.js';
import { PlayerTagWithTag } from '../contract/index.js';
import { mapDbError } from '../../../common/errors/index.js';

export const TagNotFoundError = makeNotFoundError('Tag');

function toWithTag(
  pt: typeof playerTag.$inferSelect,
  t: Pick<Tag, 'key' | 'color'>,
): PlayerTagWithTag {
  return { ...pt, tag: { key: t.key, color: t.color } };
}

export class TagService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly event: EventBus,
  ) {}

  private async _findTagByKeyOrThrow(tagKey: string, trx: DrizzleTx): Promise<Tag> {
    const results = await trx.select().from(tag).where(eq(tag.key, tagKey)).limit(1);
    if (!results.length) {
      throw new TagNotFoundError(tagKey);
    }
    return results[0];
  }

  public async createTag(args: CreateTagInput, actorUserId: string): Promise<Tag> {
    try {
      const db = this.drizzle.db;
      const [created] = await db.insert(tag).values(args).returning();
      return created;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async deleteTag(args: DeleteTagInput, actorUserId: string): Promise<boolean> {
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
          tagColor: tag.color,
        })
        .from(playerTag)
        .innerJoin(tag, eq(playerTag.tagId, tag.id))
        .where(where)
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(playerTag).where(where),
    ]);
    return {
      items: rows.map((r) => toWithTag(r.pt, { key: r.tagKey, color: r.tagColor })),
      total: Number(n),
      page,
      limit,
    };
  }

  public async assignPlayerTag(args: AssignPlayerTagInput): Promise<PlayerTagWithTag> {
    try {
      const { tagKey, ...restArgs } = args;
      const db = this.drizzle.db;
      return await db.transaction(async (trx) => {
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
          throw new Error(`Tag already assigned to player`);
        }
        const [created] = await trx
          .insert(playerTag)
          .values({ ...restArgs, tagId: foundTag.id })
          .returning();
        return toWithTag(created, foundTag);
      });
    } catch (e) {
      mapDbError(e);
    }
  }

  public async removePlayerTag(args: RemovePlayerTagInput): Promise<PlayerTagWithTag> {
    try {
      const db = this.drizzle.db;
      return await db.transaction(async (trx) => {
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
          throw new Error(`Active tag assignment not found`);
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
        return toWithTag(updated, foundTag);
      });
    } catch (e) {
      mapDbError(e);
    }
  }
}
