import { DrizzleService, DrizzleTx, EventBus } from '@blurifycom/core/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { user } from '../../identity/schema/index.js';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  PlayerTag,
  RemovePlayerTagInput,
  Tag,
  TagAssignSource,
} from '@blurifycom/core/contracts';
import { playerTag, tag } from '../schema/database.js';
import { mapDbError } from '../../../common/errors/index.js';

export class TagService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly event: EventBus,
  ) {}

  private async _findTagByKeyOrThrow(tagKey: string, trx: DrizzleTx): Promise<Tag> {
    const results = await trx.select().from(tag).where(eq(tag.key, tagKey)).limit(1);
    if (!results.length) {
      throw new Error(`Tag with key: ${tagKey} does not exist`);
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

  public async assignPlayerTag(args: AssignPlayerTagInput): Promise<PlayerTag> {
    try {
      const { tagKey, ...restArgs } = args;
      const db = this.drizzle.db;
      return await db.transaction(async (trx) => {
        const foundTag = await this._findTagByKeyOrThrow(tagKey, trx);
        const foundActivePlayerTag = await trx
          .select()
          .from(playerTag)
          .where(
            and(
              eq(playerTag.tagId, foundTag.id),
              eq(playerTag.playerId, args.playerId),
              isNotNull(playerTag.removalActor),
              isNotNull(playerTag.removalReason),
              isNotNull(playerTag.removedAt),
            ),
          )
          .limit(1);
        if (foundActivePlayerTag.length > 1) {
          throw new Error(`Duplicate active tag for the player`);
        }
        const [createdPlayerTag] = await trx
          .insert(playerTag)
          .values({
            ...restArgs,
            tagId: foundTag.id,
          })
          .returning();
        return createdPlayerTag;
      });
    } catch (e) {
      mapDbError(e);
    }
  }

  public async removePlayerTag(args: RemovePlayerTagInput): Promise<PlayerTag> {
    const { tagKey, ...rest } = args;
    try {
      const db = this.drizzle.db;
      return await db.transaction(async (trx) => {
        const foundTag = await this._findTagByKeyOrThrow(tagKey, trx);
        const foundActivePlayerTag = await trx
          .select()
          .from(playerTag)
          .where(
            and(
              eq(playerTag.tagId, foundTag.id),
              eq(playerTag.playerId, args.playerId),
              isNotNull(playerTag.removalActor),
              isNotNull(playerTag.removalReason),
              isNotNull(playerTag.removedAt),
            ),
          )
          .limit(1);
        if (foundActivePlayerTag.length > 1) {
          throw new Error(`Duplicate active tag for the player`);
        }
        const [updated] = await trx
          .update(playerTag)
          .set({
            ...rest,
          })
          .where(eq(playerTag.id, foundActivePlayerTag[0].id))
          .returning();
        return updated;
      });
    } catch (e) {
      mapDbError(e);
    }
  }
}
