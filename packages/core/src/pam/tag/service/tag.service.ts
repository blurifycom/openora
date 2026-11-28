import {
  DrizzleService,
  DrizzleTx,
  type DrizzleDb,
  EventBus,
  findOneOrThrow,
  makeNotFoundError,
  makeConflictError,
  pageToOffset,
  alreadyInUseError,
} from '@openora/core/server';
import { and, asc, count, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import {
  AssignPlayerTagInput,
  CreateTagInput,
  DeleteTagInput,
  RemovePlayerTagInput,
  ReplacePlayerTagInput,
  type PlayerTags,
  type Player,
  type PlayerStatus,
  type PlayEligibilityPort,
  type TagKey,
  type User,
  type ClientMeta,
  type PaginationOptions,
  type AuditWritePort,
  type DomainEventPayload,
  type Uuid,
} from '@openora/core/contracts';
import { SYSTEM_ACTOR_ID, type PlayerTagSortBy, type PlayerTagWithTag } from '../contract/index.js';
import { player } from '@openora/core/pam/schema/profile';
import { playerTag, tag, type Tag } from '../schema/index.js';
import { mapDbError } from '@openora/core/common/errors';
import { toTag, toPlayerTagWithTag } from './tag-mappers.js';
import type { PlayerTagAssignMetadata } from '../contract/player-tag-assign-metadata.js';

type AssignPlayerTagArgs = AssignPlayerTagInput & {
  assignMetadata?: PlayerTagAssignMetadata | null;
};

export function pgErrorCode(e: unknown): string | undefined {
  if (e instanceof DatabaseError) {
    return e.code;
  }
  if (e instanceof Error && e.cause instanceof DatabaseError) {
    return e.cause.code;
  }
  return undefined;
}

export const TagNotFoundError = makeNotFoundError('Tag');
export const TagAlreadyInUseError = alreadyInUseError('Tag');
export const TagAssignmentNotFoundError = makeNotFoundError('Tag Assignment');
export const TagKeyConflictError = makeConflictError(
  'TagKeyConflictError',
  'Tag key already exists',
);
export const TagInUseError = makeConflictError(
  'TagInUseError',
  'Tag is still referenced by a player tag or tag rule and cannot be deleted',
);
export const TagRemovalReasonRequiredError = makeConflictError(
  'TagRemovalReasonRequiredError',
  'A removal reason is required for sticky tags',
);
export const PlayerNotFoundError = makeNotFoundError('Player');
export const PlayerNotEligibleForTagError = makeConflictError(
  'PlayerNotEligibleForTagError',
  'Player is not eligible for this tag',
);

const VIP_ELIGIBLE_STATUSES: ReadonlySet<PlayerStatus> = new Set(['active', 'dormant']);

export type TagAssignmentRefusal =
  | 'player_not_found'
  | 'tag_not_found'
  | 'tag_already_active'
  | 'player_not_eligible';

type AssignablePlayer = Pick<typeof player.$inferSelect, 'id' | 'userId' | 'status'>;

const DEFAULT_MANUAL_REMOVAL_REASON = 'manual tag removal';

export function resolveRemovalReason(reason: string | undefined, isSticky: boolean) {
  const normalized = reason?.trim();
  if (isSticky && !normalized) {
    throw new TagRemovalReasonRequiredError();
  }
  return normalized || DEFAULT_MANUAL_REMOVAL_REASON;
}

export function mergeAssignMetadata(
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

type TagPlayerChange = DomainEventPayload<'tag.player.assigned'>;

export function tagChangeAuditEntry(
  action: 'tag.player.assigned' | 'tag.player.removed',
  change: TagPlayerChange,
) {
  return {
    actorType: change.actorId === SYSTEM_ACTOR_ID ? ('system' as const) : ('admin' as const),
    actorId: change.actorId,
    action,
    resourceType: 'player',
    resourceId: change.playerId,
    after: { tagKey: change.tagKey, reason: change.reason },
    ip: change.ip ?? null,
    userAgent: change.userAgent ?? null,
  };
}

export class TagService implements PlayerTags {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly event: EventBus,
    private readonly playEligibility: PlayEligibilityPort,
    private readonly audit: AuditWritePort,
  ) {}

  private async _recordTagChange(
    trx: DrizzleTx,
    action: 'tag.player.assigned' | 'tag.player.removed',
    change: TagPlayerChange,
  ) {
    await this.audit.recordInTransaction(trx, tagChangeAuditEntry(action, change));
    return { ...change, auditRecorded: true as const };
  }

  public async getActiveTagKeys(userIds: readonly string[], tx?: DrizzleTx) {
    const result = new Map<string, TagKey[]>();
    if (userIds.length === 0) {
      return result;
    }
    const rows = await (tx ?? this.drizzle.db)
      .select({ userId: player.userId, key: tag.key })
      .from(player)
      .innerJoin(playerTag, and(eq(playerTag.playerId, player.id), isNull(playerTag.removedAt)))
      .innerJoin(tag, eq(tag.id, playerTag.tagId))
      .where(sql`${player.userId} = ANY(${sql.param([...userIds])}::uuid[])`);
    for (const row of rows) {
      const keys = result.get(row.userId) ?? [];
      keys.push(row.key);
      result.set(row.userId, keys);
    }
    return result;
  }

  public async listActiveHoldersByTagKey(
    tagKey: TagKey,
  ): Promise<
    { userId: string; playerId: string; assignMetadata: PlayerTagAssignMetadata | null }[]
  > {
    const rows = await this.drizzle.db
      .select({
        userId: player.userId,
        playerId: playerTag.playerId,
        assignMetadata: playerTag.assignMetadata,
      })
      .from(playerTag)
      .innerJoin(tag, eq(playerTag.tagId, tag.id))
      .innerJoin(player, eq(player.id, playerTag.playerId))
      .where(and(eq(tag.key, tagKey), isNull(playerTag.removedAt)));
    return rows.map((r) => ({ ...r, assignMetadata: r.assignMetadata ?? null }));
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
      if (pgErrorCode(e) === '23505') {
        throw new TagKeyConflictError();
      }
      mapDbError(e);
    }
  }

  public async deleteTag(args: DeleteTagInput, actorId: User['id']) {
    try {
      const db = this.drizzle.db;
      const deleted = await db.delete(tag).where(eq(tag.key, args.key)).returning();
      if (deleted.length === 0) {
        throw new TagNotFoundError(args.key);
      }
      void this.event.emit('tag.deleted', { key: args.key, actorId });
      return true;
    } catch (e) {
      if (pgErrorCode(e) === '23503') {
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

  private async _assignPlayerTagOnTx(
    trx: DrizzleTx,
    args: AssignPlayerTagArgs,
  ): Promise<{ status: 'created'; row: PlayerTagWithTag } | { status: 'already_active' }> {
    const { tagKey, ...restArgs } = args;
    const foundTag = await this._findTagByKeyOrThrow(tagKey, trx);
    const [existing] = await this._findActiveAssignment(trx, foundTag.id, args.playerId);
    if (existing) {
      const merged = mergeAssignMetadata(existing.assignMetadata, args.assignMetadata);
      if (merged !== existing.assignMetadata) {
        await trx
          .update(playerTag)
          .set({ assignMetadata: merged })
          .where(eq(playerTag.id, existing.id));
      }
      return { status: 'already_active' };
    }
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
      const outcome = await db.transaction(async (trx) => {
        const assigned = await this._assignPlayerTagOnTx(trx, args);
        if (assigned.status === 'already_active') {
          return assigned;
        }
        const event = await this._recordTagChange(trx, 'tag.player.assigned', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: args.assignReason,
          actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        });
        return { ...assigned, event };
      });
      if (outcome.status === 'already_active') {
        throw new TagAlreadyInUseError();
      }
      void this.event.emit('tag.player.assigned', outcome.event);
      return outcome.row;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async screenWithdrawal({
    userId,
    transactionId,
    review,
  }: {
    userId: User['id'];
    transactionId: Uuid;
    review: AssignPlayerTagArgs | null;
  }): Promise<boolean> {
    return this.drizzle.db.transaction(async (trx) => {
      const assigned = review ? await this._assignPlayerTagOnTx(trx, review) : null;
      if (review && assigned?.status === 'created') {
        const event = await this._recordTagChange(trx, 'tag.player.assigned', {
          playerId: review.playerId,
          tagKey: review.tagKey,
          reason: review.assignReason,
          actorId: review.assignActorUserId ?? SYSTEM_ACTOR_ID,
        });
        await this.event.emitInTransaction(trx, 'tag.player.assigned', event);
      }
      await this.event.emitInTransaction(trx, 'tag.withdrawal.screened', {
        userId,
        transactionId,
        reviewRequired: review !== null,
      });
      return assigned?.status === 'created';
    });
  }

  private _findActiveAssignment(trx: DrizzleTx, tagId: Tag['id'], playerId: Player['id']) {
    return trx
      .select()
      .from(playerTag)
      .where(
        and(
          eq(playerTag.tagId, tagId),
          eq(playerTag.playerId, playerId),
          isNull(playerTag.removedAt),
        ),
      )
      .limit(1);
  }

  private async _removePlayerTagOnTx(trx: DrizzleTx, args: RemovePlayerTagInput) {
    const foundTag = await this._findTagByKeyOrThrow(args.tagKey, trx);
    const removalReason = resolveRemovalReason(args.removalReason, foundTag.isSticky);
    const active = findOneOrThrow(
      await this._findActiveAssignment(trx, foundTag.id, args.playerId),
      new TagAssignmentNotFoundError(args.playerId),
    );
    const [updated] = await trx
      .update(playerTag)
      .set({
        removedAt: new Date(),
        removalReason,
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
        const removed = await this._removePlayerTagOnTx(trx, args);
        const recorded = await this._recordTagChange(trx, 'tag.player.removed', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: removed.removalReason ?? DEFAULT_MANUAL_REMOVAL_REASON,
          actorId: args.removalActorUserId ?? SYSTEM_ACTOR_ID,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        });
        return { row: removed, event: recorded };
      });
      void this.event.emit('tag.player.removed', result.event);
      return result.row;
    } catch (e) {
      mapDbError(e);
    }
  }

  public async replacePlayerTag(args: ReplacePlayerTagInput) {
    try {
      const db = this.drizzle.db;
      const { removalReason, ...assignArgs } = args;
      const [activeAtStart] = await this._activeAssignmentByKey(db, args.playerId, args.tagKey);
      const result = await db.transaction(async (trx) => {
        await trx
          .select({ id: player.id })
          .from(player)
          .where(eq(player.id, args.playerId))
          .for('update');

        const [activeAfterWait] = await this._activeAssignmentByKey(
          trx,
          args.playerId,
          args.tagKey,
        );
        if (
          activeAfterWait &&
          (activeAtStart === undefined || activeAfterWait.id !== activeAtStart.id)
        ) {
          throw new TagAlreadyInUseError();
        }

        let removed = false;
        try {
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
          throw new TagAlreadyInUseError();
        }
        const actorId = args.assignActorUserId ?? SYSTEM_ACTOR_ID;
        const removedEvent = removed
          ? await this._recordTagChange(trx, 'tag.player.removed', {
              playerId: args.playerId,
              tagKey: args.tagKey,
              reason: removalReason,
              actorId,
            })
          : null;
        const assignedEvent = await this._recordTagChange(trx, 'tag.player.assigned', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: args.assignReason,
          actorId,
        });
        return { row: assigned.row, removedEvent, assignedEvent };
      });
      if (result.removedEvent) {
        void this.event.emit('tag.player.removed', result.removedEvent);
      }
      void this.event.emit('tag.player.assigned', result.assignedEvent);
      return result.row;
    } catch (e) {
      mapDbError(e);
    }
  }

  private _assignablePlayer(db: DrizzleDb | DrizzleTx, playerId: Player['id']) {
    return db
      .select({ id: player.id, userId: player.userId, status: player.status })
      .from(player)
      .where(eq(player.id, playerId));
  }

  private _activeAssignmentByKey(
    db: DrizzleDb | DrizzleTx,
    playerId: Player['id'],
    tagKey: TagKey,
  ) {
    return db
      .select({ id: playerTag.id })
      .from(playerTag)
      .innerJoin(tag, eq(tag.id, playerTag.tagId))
      .where(
        and(eq(playerTag.playerId, playerId), eq(tag.key, tagKey), isNull(playerTag.removedAt)),
      )
      .limit(1);
  }

  private async _hasActiveTag(db: DrizzleDb | DrizzleTx, playerId: Player['id'], tagKey: TagKey) {
    const [active] = await this._activeAssignmentByKey(db, playerId, tagKey);
    return active !== undefined;
  }

  private async _isEligibleForTag(
    db: DrizzleDb | DrizzleTx,
    target: AssignablePlayer,
    tagKey: TagKey,
  ) {
    if (tagKey !== 'vip') {
      return true;
    }
    if (!VIP_ELIGIBLE_STATUSES.has(target.status)) {
      return false;
    }
    if (await this._hasActiveTag(db, target.id, 'self_excluded')) {
      return false;
    }
    return !(await this.playEligibility.isRestricted(target.userId));
  }

  public async assignmentRefusal(
    playerId: Player['id'],
    tagKey: TagKey,
  ): Promise<TagAssignmentRefusal | null> {
    const db = this.drizzle.db;
    const [target] = await this._assignablePlayer(db, playerId).limit(1);
    if (!target) {
      return 'player_not_found';
    }
    const [catalogTag] = await db
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.key, tagKey))
      .limit(1);
    if (!catalogTag) {
      return 'tag_not_found';
    }
    if (await this._hasActiveTag(db, playerId, tagKey)) {
      return 'tag_already_active';
    }
    if (!(await this._isEligibleForTag(db, target, tagKey))) {
      return 'player_not_eligible';
    }
    return null;
  }

  public async assignPlayerTagForProposal(args: AssignPlayerTagArgs) {
    try {
      const outcome = await this.drizzle.db.transaction(async (trx) => {
        const target = findOneOrThrow(
          await this._assignablePlayer(trx, args.playerId).for('share'),
          new PlayerNotFoundError(args.playerId),
        );
        if (await this._hasActiveTag(trx, target.id, args.tagKey)) {
          return { status: 'already_active' as const };
        }
        if (!(await this._isEligibleForTag(trx, target, args.tagKey))) {
          throw new PlayerNotEligibleForTagError();
        }
        const assigned = await this._assignPlayerTagOnTx(trx, args);
        if (assigned.status === 'already_active') {
          return assigned;
        }
        const event = await this._recordTagChange(trx, 'tag.player.assigned', {
          playerId: args.playerId,
          tagKey: args.tagKey,
          reason: args.assignReason,
          actorId: args.assignActorUserId ?? SYSTEM_ACTOR_ID,
        });
        return { ...assigned, event };
      });
      if (outcome.status === 'created') {
        void this.event.emit('tag.player.assigned', outcome.event);
        return { status: outcome.status, row: outcome.row };
      }
      return outcome;
    } catch (e) {
      mapDbError(e);
    }
  }
}
