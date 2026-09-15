import { GameTagSnapshotSchema } from '@openora/core/contracts';
import {
  DrizzleService,
  findOneOrThrow,
  isUniqueConstraintViolation,
  likeContains,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import { and, asc, count, eq, ilike, ne } from 'drizzle-orm';
import { gameTag, gameTagGame, type GameTag } from '../schema/index.js';
import { toGameTagSummary, type CatalogActor } from '../../shared/game-catalog.js';
import type {
  CreateGameTagInput,
  ListAdminTagsInput,
  UpdateGameTagInput,
} from '../contract/index.js';

export const GameTagNotFoundError = makeNotFoundError('GameTag');
export const GameTagNameTakenError = makeConflictError(
  'GameTagNameTakenError',
  'A game tag with this name already exists',
);
export const GameTagSystemDeletionError = makeConflictError(
  'GameTagSystemDeletionError',
  'System game tags cannot be deleted',
);

function toGameTagEventSnapshot(record: typeof gameTag.$inferSelect) {
  return GameTagSnapshotSchema.parse(toGameTagSummary(record));
}

function toGameTagDetail(record: typeof gameTag.$inferSelect) {
  const dates = serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });

  return {
    ...toGameTagSummary(record),
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt,
  };
}

export class GameTagService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listTagsAdmin({ page, limit, q, type, visibility }: ListAdminTagsInput) {
    const where = and(
      q ? ilike(gameTag.name, likeContains(q)) : undefined,
      type ? eq(gameTag.type, type) : undefined,
      visibility ? eq(gameTag.visibility, visibility) : undefined,
    );

    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(gameTag)
        .where(where)
        .orderBy(asc(gameTag.name))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameTag).where(where),
    ]);

    return { items: rows.map(toGameTagDetail), total: Number(n), page, limit };
  }

  async getTag(id: GameTag['id']) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(gameTag).where(eq(gameTag.id, id)).limit(1),
      new GameTagNotFoundError(id),
    );

    return toGameTagDetail(record);
  }

  async createTag({
    name,
    visibility = 'invisible',
    metadata = null,
    actorId,
    ip,
    userAgent,
  }: CreateGameTagInput & CatalogActor) {
    let record: typeof gameTag.$inferSelect;

    try {
      record = await this.drizzle.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: gameTag.id })
          .from(gameTag)
          .where(eq(gameTag.name, name))
          .limit(1);
        if (existing) {
          throw new GameTagNameTakenError();
        }
        const [created] = await tx
          .insert(gameTag)
          .values({ name, visibility, metadata })
          .returning();
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameTagNameTakenError();
      }
      throw error;
    }

    this.events.emit('gaming.tag.created', {
      tagId: record.id,
      ...toGameTagEventSnapshot(record),
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    return toGameTagDetail(record);
  }

  async updateTag({
    id,
    actorId,
    ip,
    userAgent,
    ...patchInput
  }: UpdateGameTagInput & CatalogActor) {
    const hasChanges = Object.values(patchInput).some((value) => value !== undefined);

    if (!hasChanges) {
      return this.getTag(id);
    }

    const { existing, updated } = await this.drizzle.db
      .transaction(async (tx) => {
        const existing = findOneOrThrow(
          await tx.select().from(gameTag).where(eq(gameTag.id, id)).for('update'),
          new GameTagNotFoundError(id),
        );

        if (patchInput.name !== undefined && patchInput.name !== existing.name) {
          const [clash] = await tx
            .select({ id: gameTag.id })
            .from(gameTag)
            .where(and(eq(gameTag.name, patchInput.name), ne(gameTag.id, id)))
            .limit(1);
          if (clash) {
            throw new GameTagNameTakenError();
          }
        }

        const updated = findOneOrThrow(
          await tx.update(gameTag).set(patchInput).where(eq(gameTag.id, id)).returning(),
          new GameTagNotFoundError(id),
        );

        return { existing, updated };
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintViolation(error)) {
          throw new GameTagNameTakenError();
        }

        throw error;
      });

    this.events.emit('gaming.tag.updated', {
      tagId: updated.id,
      actorId,
      before: toGameTagEventSnapshot(existing),
      after: toGameTagEventSnapshot(updated),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    return toGameTagDetail(updated);
  }

  async deleteTag({ id, actorId, ip, userAgent }: { id: GameTag['id'] } & CatalogActor) {
    const { deleted, affectedGameIds } = await this.drizzle.db.transaction(async (tx) => {
      const existing = findOneOrThrow(
        await tx.select().from(gameTag).where(eq(gameTag.id, id)).for('update'),
        new GameTagNotFoundError(id),
      );

      if (existing.type !== 'custom') {
        throw new GameTagSystemDeletionError();
      }

      const affectedLinks = await tx
        .select({ gameId: gameTagGame.gameId })
        .from(gameTagGame)
        .where(eq(gameTagGame.tagId, id));

      const deleted = findOneOrThrow(
        await tx.delete(gameTag).where(eq(gameTag.id, id)).returning(),
        new GameTagNotFoundError(id),
      );

      return { deleted, affectedGameIds: affectedLinks.map((link) => link.gameId) };
    });

    this.events.emit('gaming.tag.deleted', {
      tagId: deleted.id,
      actorId,
      before: toGameTagEventSnapshot(deleted),
      after: { deleted: true, affectedGameIds },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    return true;
  }
}
