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
import { and, asc, count, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
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
  type ClientMeta,
  type PaginationOptions,
} from '@openora/core/contracts';
import type { PlayerTagSortBy, PlayerTagWithTag } from '../contract/index.js';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag } from '../schema/index.js';
import { mapDbError } from '@openora/core/common/errors';
import { toTag, toPlayerTagWithTag, SYSTEM_ACTOR_ID } from './tag-mappers.js';
import type { PlayerTagAssignMetadata } from '../contract/player-tag-assign-metadata.js';

// AssignPlayerTagInput is the admin wire-contract type (free-text assignReason only -
// admins never supply structured metadata). This is the internal superset used by
// TagService's assign methods so event-driven callers (TagEvaluationService) can attach
// typed breach detail without widening the public admin contract.
type AssignPlayerTagArgs = AssignPlayerTagInput & {
  assignMetadata?: PlayerTagAssignMetadata | null;
};

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

// "First evidence wins per breach dimension, but a dimension that was never recorded gets
// filled in the moment it's observed." Never overwrites an already-populated dimension with
// fresher numbers - once a dimension has ever been recorded, the resweep treats it as sticky.
// Returns the SAME `existing` reference when nothing new was merged in, so the caller can
// detect a no-op write via reference equality.
function mergeAssignMetadata(
  existing: PlayerTagAssignMetadata | null,
  incoming: PlayerTagAssignMetadata | null | undefined,
): PlayerTagAssignMetadata | null {
  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }
  if (existing.amountBreach && existing.countBreach) {
    return existing;
  }
  return {
    amountBreach: existing.amountBreach ?? incoming.amountBreach,
    countBreach: existing.countBreach ?? incoming.countBreach,
  };
}

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
   * Active holders (auth `userId`, not `player.id`) of tagKey, each with the
   * assignMetadata recorded at assignment time. Internal to this module - used only by
   * TagEvaluationService for the daily high_risk resweep to gate removal on WHICH breach
   * condition originally fired (an amount breach, or a null/legacy row, must never be
   * auto-cleared); deliberately not exposed on the PLAYER_TAGS port since no other module
   * needs "list holders of tag X" today.
   */
  public async listActiveHoldersByTagKey(
    tagKey: TagKey,
  ): Promise<{ userId: string; assignMetadata: PlayerTagAssignMetadata | null }[]> {
    const rows = await this.drizzle.db
      .select({ userId: player.userId, assignMetadata: playerTag.assignMetadata })
      .from(playerTag)
      .innerJoin(tag, eq(playerTag.tagId, tag.id))
      .innerJoin(player, eq(player.id, playerTag.playerId))
      .where(and(eq(tag.key, tagKey), isNull(playerTag.removedAt)));
    return rows.map((r) => ({ userId: r.userId, assignMetadata: r.assignMetadata ?? null }));
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

  public async listPlayerTags({
    playerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<{ playerId: Player['id'] }, PlayerTagSortBy>) {
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

  // Core idempotent assign, shared by assignPlayerTag (own transaction) and
  // assignPlayerTagInTx (caller-supplied transaction). Does NOT emit - callers decide
  // when, since assignPlayerTagInTx's caller owns a transaction this method has no
  // visibility into committing.
  //
  // Returns a status instead of throwing for the "already active" case: throwing here
  // would roll back the merge UPDATE below along with the whole transaction when this
  // runs inside assignPlayerTag's own db.transaction(...). Returning lets that
  // transaction commit the metadata enrichment first; the public methods translate
  // 'already_active' into TagAlreadyInUseError only after the transaction has resolved.
  private async _assignPlayerTagOnTx(
    trx: DrizzleTx,
    args: AssignPlayerTagArgs,
  ): Promise<{ status: 'created'; row: PlayerTagWithTag } | { status: 'already_active' }> {
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
      // A later event can reveal a breach dimension absent from the original assignment;
      // without merging it in, the resweep would act on stale metadata and could wrongly
      // clear a still-risky player.
      const merged = mergeAssignMetadata(existing.assignMetadata, args.assignMetadata);
      if (merged !== existing.assignMetadata) {
        await trx
          .update(playerTag)
          .set({ assignMetadata: merged })
          .where(eq(playerTag.id, existing.id));
      }
      return { status: 'already_active' };
    }
    // The loser of a genuine race hits the unique index here instead: its insert is a
    // no-op (empty returning()), so it also reports 'already_active' - tryAssignTag
    // already treats the resulting TagAlreadyInUseError as an idempotent no-op.
    const [created] = await trx
      .insert(playerTag)
      .values({ ...restArgs, tagId: foundTag.id })
      .onConflictDoNothing({
        target: [playerTag.tagId, playerTag.playerId],
        where: isNull(playerTag.removedAt),
      })
      .returning();
    if (!created) {
      return { status: 'already_active' };
    }
    return { status: 'created', row: toPlayerTagWithTag(created, foundTag.key) };
  }

  public async assignPlayerTag(args: AssignPlayerTagArgs, meta?: ClientMeta) {
    try {
      const db = this.drizzle.db;
      const outcome = await db.transaction((trx) => this._assignPlayerTagOnTx(trx, args));
      if (outcome.status === 'already_active') {
        throw new TagAlreadyInUseError();
      }
      void this.event.emit('tag.player.assigned', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.assignReason,
        actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return outcome.row;
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
  public async assignPlayerTagInTx(trx: DrizzleTx, args: AssignPlayerTagArgs) {
    try {
      const outcome = await this._assignPlayerTagOnTx(trx, args);
      if (outcome.status === 'already_active') {
        throw new TagAlreadyInUseError();
      }
      void this.event.emit('tag.player.assigned', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.assignReason,
        actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
      });
      return outcome.row;
    } catch (e) {
      mapDbError(e);
    }
  }

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

  public async removePlayerTag(args: RemovePlayerTagInput, meta?: ClientMeta) {
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
        actorId: args.removalActorUserId ?? SYSTEM_ACTOR_ID,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
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
        if (assigned.status === 'already_active') {
          // Unlike assignPlayerTag/assignPlayerTagInTx (where a lost race is an
          // idempotent no-op that must still let a metadata merge commit), a lost
          // race HERE must roll back the whole swap, including the removal above -
          // see the class doc: nothing may commit half-way. Throwing inside this
          // db.transaction callback is exactly how that rollback happens.
          throw new TagAlreadyInUseError();
        }
        return { row: assigned.row, removed };
      });
      if (result.removed) {
        void this.event.emit('tag.player.removed', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: removalReason,
          actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
        });
      }
      void this.event.emit('tag.player.assigned', {
        playerId: args.playerId,
        tagKey: args.tagKey,
        reason: args.assignReason,
        actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
      });
      return result.row;
    } catch (e) {
      mapDbError(e);
    }
  }
}
