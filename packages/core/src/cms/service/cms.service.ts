import { type EventBus, makeNotFoundError } from '@oss/core/server';
import { DrizzleService, findOneOrThrow } from '@oss/core/server';
import { eq, and, asc, desc } from 'drizzle-orm';
import { page as pageTable, banner as bannerTable } from '../schema/index.js';
import type { Page, Banner } from '../schemas/index.js';

export const PageNotFoundError = makeNotFoundError('Page');
export const BannerNotFoundError = makeNotFoundError('Banner');

function toPage(record: {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}): Page {
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
}): Banner {
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
  ) {}

  async listPages(): Promise<Omit<Page, 'content'>[]> {
    const pages = await this.drizzle.db
      .select({
        id: pageTable.id,
        slug: pageTable.slug,
        title: pageTable.title,
        publishedAt: pageTable.publishedAt,
        createdAt: pageTable.createdAt,
      })
      .from(pageTable)
      .orderBy(desc(pageTable.createdAt));
    return pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async getPage(slug: string): Promise<Page> {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.slug, slug)),
      new PageNotFoundError(slug),
    );
    return toPage(record);
  }

  async createPage(input: {
    slug: string;
    title: string;
    content?: unknown;
    publishedAt?: string;
  }): Promise<Page> {
    const [record] = await this.drizzle.db
      .insert(pageTable)
      .values({
        slug: input.slug,
        title: input.title,
        content: (input.content ?? {}) as object,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
      })
      .returning();
    if (record!.publishedAt) {
      this.events.emit('cms.page.published', { pageId: record!.id, slug: record!.slug });
    }
    return toPage(record!);
  }

  async updatePage(input: {
    id: string;
    slug?: string;
    title?: string;
    content?: unknown;
    publishedAt?: string | null;
  }): Promise<Page> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.id, input.id)),
      new PageNotFoundError(input.id),
    );

    const wasPublished = existing.publishedAt !== null;

    const patch: Partial<typeof pageTable.$inferInsert> = {};
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.title !== undefined) patch.title = input.title;
    if (input.content !== undefined) patch.content = input.content as object;
    if (input.publishedAt !== undefined)
      patch.publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;

    const [record] = await this.drizzle.db
      .update(pageTable)
      .set(patch)
      .where(eq(pageTable.id, input.id))
      .returning();

    const nowPublished = record!.publishedAt !== null;
    if (!wasPublished && nowPublished) {
      this.events.emit('cms.page.published', { pageId: record!.id, slug: record!.slug });
    }

    return toPage(record!);
  }

  async deletePage(id: string): Promise<{ success: true }> {
    findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.id, id)),
      new PageNotFoundError(id),
    );
    await this.drizzle.db.delete(pageTable).where(eq(pageTable.id, id));
    return { success: true };
  }

  async listBanners(): Promise<Banner[]> {
    const banners = await this.drizzle.db
      .select()
      .from(bannerTable)
      .orderBy(asc(bannerTable.placement), asc(bannerTable.sortOrder));
    return banners.map(toBanner);
  }

  async listBannersByPlacement(placement: string): Promise<Banner[]> {
    const banners = await this.drizzle.db
      .select()
      .from(bannerTable)
      .where(and(eq(bannerTable.placement, placement), eq(bannerTable.isActive, true)))
      .orderBy(asc(bannerTable.sortOrder));
    return banners.map(toBanner);
  }

  async createBanner(input: {
    placement: string;
    title: string;
    imageUrl: string;
    linkUrl?: string;
    sortOrder?: number;
  }): Promise<Banner> {
    const [record] = await this.drizzle.db
      .insert(bannerTable)
      .values({
        placement: input.placement,
        title: input.title,
        imageUrl: input.imageUrl,
        linkUrl: input.linkUrl ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    return toBanner(record!);
  }

  async updateBanner(input: {
    id: string;
    placement?: string;
    title?: string;
    imageUrl?: string;
    linkUrl?: string | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<Banner> {
    findOneOrThrow(
      await this.drizzle.db.select().from(bannerTable).where(eq(bannerTable.id, input.id)),
      new BannerNotFoundError(input.id),
    );

    const patch: Partial<typeof bannerTable.$inferInsert> = {};
    if (input.placement !== undefined) patch.placement = input.placement;
    if (input.title !== undefined) patch.title = input.title;
    if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl;
    if (input.linkUrl !== undefined) patch.linkUrl = input.linkUrl;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

    const [record] = await this.drizzle.db
      .update(bannerTable)
      .set(patch)
      .where(eq(bannerTable.id, input.id))
      .returning();
    return toBanner(record!);
  }

  async deleteBanner(id: string): Promise<{ success: true }> {
    findOneOrThrow(
      await this.drizzle.db.select().from(bannerTable).where(eq(bannerTable.id, id)),
      new BannerNotFoundError(id),
    );
    await this.drizzle.db.delete(bannerTable).where(eq(bannerTable.id, id));
    return { success: true };
  }
}
