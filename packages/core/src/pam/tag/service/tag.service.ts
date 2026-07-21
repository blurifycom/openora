import {
  DrizzleService,
  DrizzleTx,
  EventBus,
  findOneOrThrow,
  makeNotFoundError,
  makeConflictError,
  pageToOffset,
  alreadyInUseError,
} from '@openora/core/server';
import { and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  ReplacePlayerTagInput,
  type PlayerTags,
  type Player,
  type TagKey,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag } from '../schema/index.js';
import { mapDbError } from '@openora/core/common/errors';
import { toTag, toPlayerTagWithTag } from './tag-mappers.js';

export const TagNotFoundError = makeNotFoundError('Tag');
export const TagAlreadyInUseError = alreadyInUseError('Tag');
export const TagAssignmentNotFoundError = makeNotFoundError('Tag Assignment');
// Distinct from TagAlreadyInUseError above (a player already holding this tag active) -
// this is the tag CATALOG key colliding on create.
export const TagKeyConflictError = makeConflictError(
  'TagKeyConflictError',
  'Tag key already exists',
);
// A tag can't be deleted while a playerTag/tagRule row still references it
// (onDelete: 'restrict' in the schema).
export const TagInUseError = makeConflictError(
  'TagInUseError',
  'Tag is still referenced by a player tag or tag rule and cannot be deleted',
);

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

  /**
   * userIds (auth `userId`, not `player.id`) currently holding an active assignment
   * of tagKey. Internal to this module - used only by TagEvaluationService for the
   * daily high_risk resweep; deliberately not exposed on the PLAYER_TAGS port since
   * no other module needs "list holders of tag X" today.
   */
  public async listActivePlayerUserIdsByTagKey(tagKey: TagKey): Promise<string[]> {
    const rows = await this.drizzle.db
      .select({ userId: player.userId })
      .from(playerTag)
      .innerJoin(tag, eq(playerTag.tagId, tag.id))
      .innerJoin(player, eq(player.id, playerTag.playerId))
      .where(and(eq(tag.key, tagKey), isNull(playerTag.removedAt)));
    return rows.map((r) => r.userId);
  }

  private async _findTagByKeyOrThrow(tagKey: TagKey, trx: DrizzleTx) {
    const results = await trx.select().from(tag).where(eq(tag.key, tagKey)).limit(1);
    return toTag(findOneOrThrow(results, new TagNotFoundError(tagKey)));
  }

  public async createTag(args: CreateTagInput, actorId: User['id']) {
    try {
      const db = this.drizzle.db;
      const [created] = await db.insert(tag).values(args).returning();
      const result = toTag(created);
      void this.event.emit('tag.created', { key: result.key, isSticky: result.isSticky, actorId });
      return result;
    } catch (e) {
      if (e instanceof DatabaseError && e.code === '23505') {
        throw new TagKeyConflictError();
      }
      mapDbError(e);
    }
  }

  public async deleteTag(args: DeleteTagInput, actorId: User['id']) {
    try {
      const db = this.drizzle.db;
      // .returning() is the only signal a genuine delete happened - without it a
      // no-op delete of a missing key would still fall through and emit tag.deleted,
      // which the audit module records as a real deletion that never occurred.
      const deleted = await db.delete(tag).where(eq(tag.key, args.key)).returning();
      if (deleted.length === 0) {
        throw new TagNotFoundError(args.key);
      }
      void this.event.emit('tag.deleted', { key: args.key, actorId });
      return true;
    } catch (e) {
      if (e instanceof DatabaseError && e.code === '23503') {
        throw new TagInUseError();
      }
      mapDbError(e);
    }
  }

  public async listPlayerTags(playerId: Player['id'], page: number, limit: number) {
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

  // Core idempotent assign, shared by assignPlayerTag (own transaction) and
  // assignPlayerTagInTx (caller-supplied transaction). Does NOT emit - callers decide
  // when, since assignPlayerTagInTx's caller owns a transaction this method has no
  // visibility into committing.
  private async _assignPlayerTagOnTx(trx: DrizzleTx, args: AssignPlayerTagInput) {
    const { tagKey, ...restArgs } = args;
    const foundTag = await this._findTagByKeyOrThrow(tagKey, trx);
    // Fast/friendly pre-check only - the real guard is the partial unique index
    // (player_tag_active_key) backing the onConflictDoNothing below. Without it, two
    // concurrent calls (or the same at-least-once event redelivered) can both pass
    // this SELECT before either commits, creating duplicate active rows.
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
    // The loser of a genuine race hits the unique index here instead: its insert is a
    // no-op (empty returning()), so it throws the same TagAlreadyInUseError as the
    // pre-check - tryAssignTag already treats that as an idempotent no-op.
    const [created] = await trx
      .insert(playerTag)
      .values({ ...restArgs, tagId: foundTag.id })
      .onConflictDoNothing({
        target: [playerTag.tagId, playerTag.playerId],
        where: isNull(playerTag.removedAt),
      })
      .returning();
    if (!created) {
      throw new TagAlreadyInUseError();
    }
    return toPlayerTagWithTag(created, foundTag.key);
  }

  public async assignPlayerTag(args: AssignPlayerTagInput) {
    try {
      const db = this.drizzle.db;
      const result = await db.transaction((trx) => this._assignPlayerTagOnTx(trx, args));
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

  /**
   * Same idempotent assign as assignPlayerTag, but on a caller-supplied transaction handle
   * (the TAG_EVALUATION_COMMANDS command-port idiom, ADR-0017) so the write commits
   * atomically with the caller's own writes - eg wallet's withdraw() inserting the
   * withdrawal request row. Emits tag.player.assigned right after the write (mirrors
   * PlayerKycStatusWriter.setStatus): this method has no visibility into when the
   * caller's own transaction actually commits, so - like every other caller-supplied-tx
   * command port in this repo - it cannot defer the emit past that point.
   */
  public async assignPlayerTagInTx(trx: DrizzleTx, args: AssignPlayerTagInput) {
    try {
      const result = await this._assignPlayerTagOnTx(trx, args);
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

  // Core removal, shared by removePlayerTag (own transaction) and replacePlayerTag
  // (one shared transaction for the same-key swap). Throws TagAssignmentNotFoundError
  // when no active row exists. Does NOT emit - same contract as _assignPlayerTagOnTx.
  private async _removePlayerTagOnTx(trx: DrizzleTx, args: RemovePlayerTagInput) {
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
  }

  public async removePlayerTag(args: RemovePlayerTagInput) {
    try {
      const db = this.drizzle.db;
      const result = await db.transaction((trx) => this._removePlayerTagOnTx(trx, args));
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

  /**
   * Atomically replaces a player's active assignment of tagKey - the same-key value
   * swap the mutable `level` tag needs. Both halves run on ONE transaction: a missing
   * active row makes the removal a silent no-op (unlike removePlayerTag), and a
   * failure in the assign half rolls the removal back too, so the swap can never
   * commit half-way and strand the player with no active row. Under a genuine
   * concurrent replace for the same (tag, player), the loser serializes on the row
   * lock + the player_tag_active_key unique index and throws TagAlreadyInUseError
   * with NOTHING committed. Emits tag.player.removed (only when a row was actually
   * removed) and tag.player.assigned after the commit.
   */
  public async replacePlayerTag(args: ReplacePlayerTagInput) {
    try {
      const db = this.drizzle.db;
      const { removalReason, ...assignArgs } = args;
      const result = await db.transaction(async (trx) => {
        let removed = false;
        try {
          // App-level throw from findOneOrThrow, not a failed SQL statement, so
          // catching it here does not abort the surrounding Postgres transaction.
          await this._removePlayerTagOnTx(trx, {
            playerId: args.playerId,
            tagKey: args.tagKey,
            removalReason,
            removalActor: args.assignActor,
            removalActorUserId: args.assignActorUserId,
          });
          removed = true;
        } catch (e) {
          if (!(e instanceof TagAssignmentNotFoundError)) {
            throw e;
          }
        }
        const assigned = await this._assignPlayerTagOnTx(trx, assignArgs);
        return { assigned, removed };
      });
      if (result.removed) {
        void this.event.emit('tag.player.removed', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: removalReason,
          actorId: args.assignActorUserId,
        });
      }
      void this.event.emit('tag.player.assigned', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.assignReason,
        actorId: args.assignActorUserId,
      });
      return result.assigned;
    } catch (e) {
      mapDbError(e);
    }
  }
}
