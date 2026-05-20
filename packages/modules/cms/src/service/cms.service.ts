import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import type { Page, Banner } from '../schemas/index.js';

export class PageNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Page not found: ${identifier}`);
    this.name = 'PageNotFoundError';
  }
}

export class BannerNotFoundError extends Error {
  constructor(id: string) {
    super(`Banner not found: ${id}`);
    this.name = 'BannerNotFoundError';
  }
}

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

@Injectable()
export class CmsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async listPages(): Promise<Omit<Page, 'content'>[]> {
    const pages = await this.prisma.page.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        publishedAt: true,
        createdAt: true,
      },
    });
    return pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async getPage(slug: string): Promise<Page> {
    const page = await this.prisma.page.findUnique({ where: { slug } });
    if (!page) throw new PageNotFoundError(slug);
    return toPage(page);
  }

  async createPage(input: {
    slug: string;
    title: string;
    content?: unknown;
    publishedAt?: string;
  }): Promise<Page> {
    const page = await this.prisma.page.create({
      data: {
        slug: input.slug,
        title: input.title,
        content: (input.content ?? {}) as object,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
      },
    });
    if (page.publishedAt) {
      this.events.emit('cms.page.published', { pageId: page.id, slug: page.slug });
    }
    return toPage(page);
  }

  async updatePage(input: {
    id: string;
    slug?: string;
    title?: string;
    content?: unknown;
    publishedAt?: string | null;
  }): Promise<Page> {
    const existing = await this.prisma.page.findUnique({ where: { id: input.id } });
    if (!existing) throw new PageNotFoundError(input.id);

    const wasPublished = existing.publishedAt !== null;

    const page = await this.prisma.page.update({
      where: { id: input.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.content !== undefined && { content: input.content as object }),
        ...(input.publishedAt !== undefined && {
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        }),
      },
    });

    const nowPublished = page.publishedAt !== null;
    if (!wasPublished && nowPublished) {
      this.events.emit('cms.page.published', { pageId: page.id, slug: page.slug });
    }

    return toPage(page);
  }

  async deletePage(id: string): Promise<{ success: true }> {
    const existing = await this.prisma.page.findUnique({ where: { id } });
    if (!existing) throw new PageNotFoundError(id);
    await this.prisma.page.delete({ where: { id } });
    return { success: true };
  }

  async listBanners(): Promise<Banner[]> {
    const banners = await this.prisma.banner.findMany({
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    });
    return banners.map(toBanner);
  }

  async listBannersByPlacement(placement: string): Promise<Banner[]> {
    const banners = await this.prisma.banner.findMany({
      where: { placement, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return banners.map(toBanner);
  }

  async createBanner(input: {
    placement: string;
    title: string;
    imageUrl: string;
    linkUrl?: string;
    sortOrder?: number;
  }): Promise<Banner> {
    const banner = await this.prisma.banner.create({
      data: {
        placement: input.placement,
        title: input.title,
        imageUrl: input.imageUrl,
        linkUrl: input.linkUrl ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    return toBanner(banner);
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
    const existing = await this.prisma.banner.findUnique({ where: { id: input.id } });
    if (!existing) throw new BannerNotFoundError(input.id);

    const banner = await this.prisma.banner.update({
      where: { id: input.id },
      data: {
        ...(input.placement !== undefined && { placement: input.placement }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
        ...(input.linkUrl !== undefined && { linkUrl: input.linkUrl }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    });
    return toBanner(banner);
  }

  async deleteBanner(id: string): Promise<{ success: true }> {
    const existing = await this.prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new BannerNotFoundError(id);
    await this.prisma.banner.delete({ where: { id } });
    return { success: true };
  }
}
