import {
  DrizzleService,
  DrizzleTx,
  EventBus,
  makeNotFoundError,
  pageToOffset,
  alreadyInUseError,
} from '@blurifycom/core/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  Tag,
  type TagKey,
  type KycStatus,
  type User,
} from '@blurifycom/core/contracts';
import { player } from '@blurifycom/core/pam/schema/profile';
import { playerTag, tag } from '../schema/index.js';
import { PlayerTagWithTag } from '../contract/index.js';
import { mapDbError } from '@blurifycom/core/common/errors';

export const TagNotFoundError = makeNotFoundError('Tag');
export const TagAlreadyInUseError = alreadyInUseError('Tag');
export const TagAssignmentNotFoundError = makeNotFoundError('Tag Assignment');

function toWithTag(pt: typeof playerTag.$inferSelect, t: Pick<Tag, 'key'>): PlayerTagWithTag {
  return { ...pt, tag: { key: t.key } };
}

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
    return results[0];
  }

  public async createTag(args: CreateTagInput): Promise<Tag> {
    try {
      const db = this.drizzle.db;
      const [created] = await db.insert(tag).values(args).returning();
      return created;
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
      items: rows.map((r) => toWithTag(r.pt, { key: r.tagKey })),
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
          throw new TagAlreadyInUseError();
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
        return toWithTag(updated, foundTag);
      });
    } catch (e) {
      mapDbError(e);
    }
  }

  /**
   * Keeps the review-triage tags (`kyc_pending` / `kyc_rejected`) in sync with a player's
   * KYC status. Idempotent under at-least-once delivery: re-adding a present tag or removing
   * an absent one is swallowed. Maps the auth `userId` (event payload) to the internal
   * `player.id` that tags are keyed on.
   */
  public async syncKycStatusTags(args: {
    userId: User['id'];
    actorId: User['id'] | null;
    status: KycStatus;
  }) {
    const [found] = await this.drizzle.db
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, args.userId))
      .limit(1);
    if (!found) return;

    const desired: TagKey | null =
      args.status === 'pending'
        ? 'kyc_pending'
        : args.status === 'rejected'
          ? 'kyc_rejected'
          : null;
    const reason = `KYC status changed to ${args.status}`;

    for (const tagKey of ['kyc_pending', 'kyc_rejected'] as const) {
      if (tagKey === desired) {
        await this.assignPlayerTag({
          playerId: found.id,
          tagKey,
          assignActor: 'scheduled',
          assignActorUserId: args.actorId,
          assignReason: reason,
        }).catch((e) => {
          if (!(e instanceof TagAlreadyInUseError)) throw e;
        });
      } else {
        await this.removePlayerTag({
          playerId: found.id,
          tagKey,
          removalActor: 'scheduled',
          removalActorUserId: args.actorId,
          removalReason: reason,
        }).catch((e) => {
          // Nothing to clear if the tag was never assigned, or its definition was never
          // seeded - both mean the player does not carry it.
          if (!(e instanceof TagAssignmentNotFoundError) && !(e instanceof TagNotFoundError)) {
            throw e;
          }
        });
      }
    }
  }
}
