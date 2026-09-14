import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  isUniqueConstraintViolation,
  likeContains,
  serializeRow,
  pageToOffset,
} from '@openora/core/server';
import { eq, and, asc, count, ilike, ne, or } from 'drizzle-orm';
import type { ClientMeta, User } from '@openora/core/contracts';
import { gameCategory } from '../schema/index.js';
import type { CreateCategoryInput, UpdateCategoryInput } from '../contract/index.js';
import { toCategorySummary } from '../../shared/game-catalog.js';

export const GameCategoryNotFoundError = makeNotFoundError('GameCategory');
export const GameCategorySlugTakenError = makeConflictError(
  'GameCategorySlugTakenError',
  'A category with this slug already exists',
);

type Actor = {
  actorId: User['id'];
} & ClientMeta;

function categorySnapshot(record: typeof gameCategory.$inferSelect) {
  return {
    slug: record.slug,
    name: record.name,
    translations: record.translations ?? {},
    icon: record.icon,
    sortOrder: record.sortOrder,
    isActive: record.isActive,
  };
}

function toCategoryDetail(record: typeof gameCategory.$inferSelect) {
  const dates = serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
  return {
    ...toCategorySummary(record),
    isActive: record.isActive,
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt,
  };
}

export class GameCategoryService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listActiveCategories({ page, limit }: { page: number; limit: number }) {
    const where = eq(gameCategory.isActive, true);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({
          id: gameCategory.id,
          slug: gameCategory.slug,
          name: gameCategory.name,
          translations: gameCategory.translations,
          icon: gameCategory.icon,
          sortOrder: gameCategory.sortOrder,
        })
        .from(gameCategory)
        .where(where)
        .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name), asc(gameCategory.slug))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameCategory).where(where),
    ]);
    return {
      items: rows.map((row) => ({ ...row, translations: row.translations ?? {} })),
      total: Number(n),
      page,
      limit,
    };
  }

  async listCategoriesAdmin({
    page,
    limit,
    q,
    isActive,
  }: {
    page: number;
    limit: number;
    q?: string;
    isActive?: boolean;
  }) {
    const where = and(
      q
        ? or(ilike(gameCategory.name, likeContains(q)), ilike(gameCategory.slug, likeContains(q)))
        : undefined,
      isActive === undefined ? undefined : eq(gameCategory.isActive, isActive),
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(gameCategory)
        .where(where)
        .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameCategory).where(where),
    ]);
    return { items: rows.map(toCategoryDetail), total: Number(n), page, limit };
  }

  async getCategory(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(gameCategory).where(eq(gameCategory.id, id)).limit(1),
      new GameCategoryNotFoundError(id),
    );
    return toCategoryDetail(record);
  }

  async getActiveCategoryBySlug(slug: string) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameCategory)
        .where(and(eq(gameCategory.slug, slug), eq(gameCategory.isActive, true)))
        .limit(1),
      new GameCategoryNotFoundError(slug),
    );
    return toCategorySummary(record);
  }

  async createCategory({
    slug,
    name,
    translations,
    icon,
    sortOrder,
    actorId,
    ip,
    userAgent,
  }: CreateCategoryInput & Actor) {
    let record: typeof gameCategory.$inferSelect;
    try {
      record = await this.drizzle.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: gameCategory.id })
          .from(gameCategory)
          .where(eq(gameCategory.slug, slug))
          .limit(1);
        if (existing) {
          throw new GameCategorySlugTakenError();
        }
        const [created] = await tx
          .insert(gameCategory)
          .values({
            slug,
            name,
            translations: translations ?? {},
            icon: icon ?? null,
            sortOrder: sortOrder ?? 0,
          })
          .returning();
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameCategorySlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.category.created', {
      categoryId: record.id,
      ...categorySnapshot(record),
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toCategoryDetail(record);
  }

  async updateCategory({ id, actorId, ip, userAgent, ...patchInput }: UpdateCategoryInput & Actor) {
    const patch: Partial<typeof gameCategory.$inferInsert> = { ...patchInput };
    const hasChanges = Object.values(patch).some((value) => value !== undefined);
    const outcome = await this.drizzle.db
      .transaction(async (tx) => {
        // The row lock serializes concurrent PATCHes, so the audited `before` is the
        // state this write replaced, never a snapshot another request already changed.
        const existing = findOneOrThrow(
          await tx
            .select()
            .from(gameCategory)
            .where(eq(gameCategory.id, id))
            .limit(1)
            .for('update'),
          new GameCategoryNotFoundError(id),
        );
        if (patchInput.slug !== undefined && patchInput.slug !== existing.slug) {
          const [clash] = await tx
            .select({ id: gameCategory.id })
            .from(gameCategory)
            .where(and(eq(gameCategory.slug, patchInput.slug), ne(gameCategory.id, id)))
            .limit(1);
          if (clash) {
            throw new GameCategorySlugTakenError();
          }
        }
        if (!hasChanges) {
          return { changed: false, before: existing, after: existing };
        }
        const updated = findOneOrThrow(
          await tx.update(gameCategory).set(patch).where(eq(gameCategory.id, id)).returning(),
          new GameCategoryNotFoundError(id),
        );
        return { changed: true, before: existing, after: updated };
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintViolation(error)) {
          throw new GameCategorySlugTakenError();
        }
        throw error;
      });
    if (!outcome.changed) {
      return toCategoryDetail(outcome.after);
    }
    this.events.emit('gaming.category.updated', {
      categoryId: id,
      actorId,
      before: categorySnapshot(outcome.before),
      after: categorySnapshot(outcome.after),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toCategoryDetail(outcome.after);
  }
}
