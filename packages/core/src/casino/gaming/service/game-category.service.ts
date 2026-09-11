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
  actorId?: User['id'];
} & ClientMeta;

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

  async listActiveCategories() {
    const rows = await this.drizzle.db
      .select({
        id: gameCategory.id,
        slug: gameCategory.slug,
        name: gameCategory.name,
        translations: gameCategory.translations,
        icon: gameCategory.icon,
        sortOrder: gameCategory.sortOrder,
      })
      .from(gameCategory)
      .where(eq(gameCategory.isActive, true))
      .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name));
    return rows.map((row) => ({ ...row, translations: row.translations ?? {} }));
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
      slug: record.slug,
      name: record.name,
      translations: record.translations ?? {},
      icon: record.icon,
      sortOrder: record.sortOrder,
      isActive: record.isActive,
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toCategoryDetail(record);
  }

  async updateCategory({ id, actorId, ip, userAgent, ...patchInput }: UpdateCategoryInput & Actor) {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(gameCategory).where(eq(gameCategory.id, id)).limit(1),
      new GameCategoryNotFoundError(id),
    );
    if (patchInput.slug !== undefined && patchInput.slug !== existing.slug) {
      const [clash] = await this.drizzle.db
        .select({ id: gameCategory.id })
        .from(gameCategory)
        .where(and(eq(gameCategory.slug, patchInput.slug), ne(gameCategory.id, id)))
        .limit(1);
      if (clash) {
        throw new GameCategorySlugTakenError();
      }
    }
    const patch: Partial<typeof gameCategory.$inferInsert> = { ...patchInput };
    const hasChanges = Object.values(patch).some((value) => value !== undefined);
    if (!hasChanges) {
      return toCategoryDetail(existing);
    }
    let updated: typeof gameCategory.$inferSelect;
    try {
      updated = findOneOrThrow(
        await this.drizzle.db
          .update(gameCategory)
          .set(patch)
          .where(eq(gameCategory.id, id))
          .returning(),
        new GameCategoryNotFoundError(id),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameCategorySlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.category.updated', {
      categoryId: updated.id,
      actorId,
      before: {
        slug: existing.slug,
        name: existing.name,
        translations: existing.translations ?? {},
        icon: existing.icon,
        sortOrder: existing.sortOrder,
        isActive: existing.isActive,
      },
      after: {
        slug: updated.slug,
        name: updated.name,
        translations: updated.translations ?? {},
        icon: updated.icon,
        sortOrder: updated.sortOrder,
        isActive: updated.isActive,
      },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toCategoryDetail(updated);
  }
}
