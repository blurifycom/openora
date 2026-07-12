import {
  type EventBus,
  makeNotFoundError,
  DrizzleService,
  findOneOrThrow,
  cached,
  invalidate,
} from '@openora/core/server';
import type { CacheAdapter, User } from '@openora/core/contracts';
import { eq, and, asc, desc, isNotNull } from 'drizzle-orm';
import { page as pageTable, banner as bannerTable } from '../schema/index.js';

export const PageNotFoundError = makeNotFoundError('Page');
export const BannerNotFoundError = makeNotFoundError('Banner');

// Public content is read far more than written; a short TTL bounds staleness
// after a publish/edit to the invalidation below, not to this window alone.
const CMS_CACHE_TTL_MS = 60_000;

const pageCacheKey = (slug: string) => `cms:page:${slug}`;
const bannersCacheKey = (placement: string) => `cms:banners:${placement}`;

function toPage(record: {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    content: record.content,
    publishedAt: record.publishedAt ? record.publishedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

function toBanner(record: {
  id: string;
  placement: string;
  title: string;
  imageUrl: string;
  linkUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
}) {
  return {
    id: record.id,
    placement: record.placement,
    title: record.title,
    imageUrl: record.imageUrl,
    linkUrl: record.linkUrl,
    isActive: record.isActive,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt.toISOString(),
  };
}

export class CmsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly cache?: CacheAdapter,
  ) {}

  // Public routes (no adminGuard, HTTP-cacheable) - published-only. There is no
  // admin equivalent yet, so a draft page is visible only via direct DB access.
  async listPages() {
    const pages = await this.drizzle.db
      .select({
        id: pageTable.id,
        slug: pageTable.slug,
        title: pageTable.title,
        publishedAt: pageTable.publishedAt,
        createdAt: pageTable.createdAt,
      })
      .from(pageTable)
      .where(isNotNull(pageTable.publishedAt))
      .orderBy(desc(pageTable.createdAt));
    return pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  // Published-only, so an unpublished slug 404s the same as a nonexistent one
  // (no draft-existence leak).
  async getPage(slug: string) {
    return cached(this.cache, pageCacheKey(slug), CMS_CACHE_TTL_MS, async () => {
      const record = findOneOrThrow(
        await this.drizzle.db
          .select()
          .from(pageTable)
          .where(and(eq(pageTable.slug, slug), isNotNull(pageTable.publishedAt))),
        new PageNotFoundError(slug),
      );
      return toPage(record);
    });
  }

  async createPage(
    input: {
      slug: string;
      title: string;
      content?: unknown;
      publishedAt?: string;
    },
    actorId: User['id'],
  ) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .insert(pageTable)
        .values({
          slug: input.slug,
          title: input.title,
          content: (input.content ?? {}) as object,
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        })
        .returning(),
      new PageNotFoundError(input.slug),
    );
    await invalidate(this.cache, pageCacheKey(input.slug));
    this.events.emit('cms.page.created', { pageId: record.id, actorId });
    if (record.publishedAt) {
      this.events.emit('cms.page.published', { pageId: record.id, slug: record.slug });
    }
    return toPage(record);
  }

  async updatePage(
    input: {
      id: string;
      slug?: string;
      title?: string;
      content?: unknown;
      publishedAt?: string | null;
    },
    actorId: User['id'],
  ) {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.id, input.id)),
      new PageNotFoundError(input.id),
    );

    const wasPublished = existing.publishedAt !== null;

    const patch: Partial<typeof pageTable.$inferInsert> = {};
    if (input.slug !== undefined) {
      patch.slug = input.slug;
    }
    if (input.title !== undefined) {
      patch.title = input.title;
    }
    if (input.content !== undefined) {
      patch.content = input.content as object;
    }
    if (input.publishedAt !== undefined) {
      patch.publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
    }

    const record = findOneOrThrow(
      await this.drizzle.db
        .update(pageTable)
        .set(patch)
        .where(eq(pageTable.id, input.id))
        .returning(),
      new PageNotFoundError(input.id),
    );

    await invalidate(this.cache, [existing.slug, input.slug ?? existing.slug].map(pageCacheKey));

    this.events.emit('cms.page.updated', { pageId: record.id, actorId });
    const nowPublished = record.publishedAt !== null;
    if (!wasPublished && nowPublished) {
      this.events.emit('cms.page.published', { pageId: record.id, slug: record.slug });
    }

    return toPage(record);
  }

  async deletePage(id: string, actorId: User['id']): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.id, id)),
      new PageNotFoundError(id),
    );
    await this.drizzle.db.delete(pageTable).where(eq(pageTable.id, id));
    await invalidate(this.cache, pageCacheKey(existing.slug));
    this.events.emit('cms.page.deleted', { pageId: id, actorId });
    return { success: true };
  }

  async listBanners() {
    const banners = await this.drizzle.db
      .select()
      .from(bannerTable)
      .orderBy(asc(bannerTable.placement), asc(bannerTable.sortOrder));
    return banners.map(toBanner);
  }

  async listBannersByPlacement(placement: string) {
    return cached(this.cache, bannersCacheKey(placement), CMS_CACHE_TTL_MS, async () => {
      const banners = await this.drizzle.db
        .select()
        .from(bannerTable)
        .where(and(eq(bannerTable.placement, placement), eq(bannerTable.isActive, true)))
        .orderBy(asc(bannerTable.sortOrder));
      return banners.map(toBanner);
    });
  }

  async createBanner(
    input: {
      placement: string;
      title: string;
      imageUrl: string;
      linkUrl?: string;
      sortOrder?: number;
    },
    actorId: User['id'],
  ) {
    const record = findOneOrThrow(
      await this.drizzle.db.insert(bannerTable).values(input).returning(),
      new BannerNotFoundError(input.placement),
    );
    await invalidate(this.cache, bannersCacheKey(input.placement));
    this.events.emit('cms.banner.created', { bannerId: record.id, actorId });
    return toBanner(record);
  }

  async updateBanner(
    input: {
      id: string;
      placement?: string;
      title?: string;
      imageUrl?: string;
      linkUrl?: string | null;
      isActive?: boolean;
      sortOrder?: number;
    },
    actorId: User['id'],
  ) {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(bannerTable).where(eq(bannerTable.id, input.id)),
      new BannerNotFoundError(input.id),
    );

    const patch: Partial<typeof bannerTable.$inferInsert> = {};
    if (input.placement !== undefined) {
      patch.placement = input.placement;
    }
    if (input.title !== undefined) {
      patch.title = input.title;
    }
    if (input.imageUrl !== undefined) {
      patch.imageUrl = input.imageUrl;
    }
    if (input.linkUrl !== undefined) {
      patch.linkUrl = input.linkUrl;
    }
    if (input.isActive !== undefined) {
      patch.isActive = input.isActive;
    }
    if (input.sortOrder !== undefined) {
      patch.sortOrder = input.sortOrder;
    }

    const record = findOneOrThrow(
      await this.drizzle.db
        .update(bannerTable)
        .set(patch)
        .where(eq(bannerTable.id, input.id))
        .returning(),
      new BannerNotFoundError(input.id),
    );
    await invalidate(
      this.cache,
      [existing.placement, input.placement ?? existing.placement].map(bannersCacheKey),
    );
    this.events.emit('cms.banner.updated', { bannerId: record.id, actorId });
    return toBanner(record);
  }

  async deleteBanner(id: string, actorId: User['id']): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(bannerTable).where(eq(bannerTable.id, id)),
      new BannerNotFoundError(id),
    );
    await this.drizzle.db.delete(bannerTable).where(eq(bannerTable.id, id));
    await invalidate(this.cache, bannersCacheKey(existing.placement));
    this.events.emit('cms.banner.deleted', { bannerId: id, actorId });
    return { success: true };
  }
}
