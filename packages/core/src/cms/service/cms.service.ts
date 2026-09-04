import {
  type EventBus,
  type DrizzleTx,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  cached,
  invalidate,
  withAdvisoryXactLock,
} from '@openora/core/server';
import type { CacheAdapter, ClientMeta, User, Uuid } from '@openora/core/contracts';
import { eq, ne, and, asc, desc, isNotNull, inArray, sql, gt, lt, gte, lte } from 'drizzle-orm';
import {
  page as pageTable,
  bannerConfiguration as bannerConfigurationTable,
  bannerImage as bannerImageTable,
  bannerSchedule as bannerScheduleTable,
} from '../schema/index.js';
import { BANNER_IMAGE_COUNT_BOUNDS, DEFAULT_LOCALE, type BannerLayout } from '../contract/index.js';
import { validateBannerImageUrl } from '../moderation/validate-banner-image-url.js';

export const PageNotFoundError = makeNotFoundError('Page');
export const BannerConfigurationNotFoundError = makeNotFoundError('BannerConfiguration');
export const BannerImageNotFoundError = makeNotFoundError('BannerImage');
export const BannerConfigurationIsDefaultError = makeConflictError(
  'BannerConfigurationIsDefaultError',
  'This configuration is currently the placement default - set a different default or unset it before deleting',
);
export const BannerConfigurationImageCountError = createDomainError<
  [layout: string, min: number, max: number, actual: number]
>('BannerConfigurationImageCountError', (layout, min, max, actual) =>
  min === max
    ? `A ${layout} banner configuration needs exactly ${min} image(s) to be set as default (has ${actual})`
    : `A ${layout} banner configuration needs ${min}-${max} images to be set as default (has ${actual})`,
);
export const BannerImageHostNotAllowedError = createDomainError<[reason: string]>(
  'BannerImageHostNotAllowedError',
  (reason) => `Banner image URL rejected: ${reason}`,
);
export const BannerScheduleNotFoundError = makeNotFoundError('BannerSchedule');
export const BannerConfigurationHasScheduleError = makeConflictError(
  'BannerConfigurationHasScheduleError',
  'This configuration has a banner schedule attached - it cannot be deleted or re-scheduled while one exists',
);
export const BannerScheduleInvalidRangeError = createDomainError<[reason: string]>(
  'BannerScheduleInvalidRangeError',
  (reason) => `Invalid banner schedule range: ${reason}`,
);
export type BannerScheduleOverlapData = { startsAt: string; endsAt: string };
export class BannerScheduleOverlapError extends Error {
  readonly data: BannerScheduleOverlapData;

  constructor(startsAt: Date | string, endsAt: Date | string) {
    const startsAtIso = startsAt instanceof Date ? startsAt.toISOString() : startsAt;
    const endsAtIso = endsAt instanceof Date ? endsAt.toISOString() : endsAt;
    super(`This placement already has a schedule for ${startsAtIso} - ${endsAtIso}`);
    this.name = 'BannerScheduleOverlapError';
    this.data = { startsAt: startsAtIso, endsAt: endsAtIso };
  }
}

// Public content is read far more than written; a short TTL bounds staleness
// after a publish/edit to the invalidation below, not to this window alone.
const CMS_CACHE_TTL_MS = 60_000;

const pageCacheKey = (slug: string) => `cms:page:${slug}`;
// Keyed per requested locale, but invalidation below only targets DEFAULT_LOCALE -
// a non-default-locale read can lag a write by up to CMS_CACHE_TTL_MS, which is
// acceptable for this public, non-money read.
const publicBannerCacheKey = (placement: string, locale: string) =>
  `cms:banner-placement:${placement}:${locale}`;
const bannerScheduleLockKey = (placement: string) => `cms:banner-schedule:${placement}`;

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

function toBannerImage(record: {
  id: string;
  bannerConfigurationId: Uuid;
  sortOrder: number;
  locale: string;
  desktopImageUrl: string;
  mobileImageUrl: string;
  linkUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    bannerConfigurationId: record.bannerConfigurationId,
    sortOrder: record.sortOrder,
    locale: record.locale,
    desktopImageUrl: record.desktopImageUrl,
    mobileImageUrl: record.mobileImageUrl,
    linkUrl: record.linkUrl,
    createdAt: record.createdAt.toISOString(),
  };
}

function toBannerConfiguration(
  record: {
    id: string;
    placement: string;
    layout: BannerLayout;
    isDefault: boolean;
    createdBy: string;
    createdAt: Date;
  },
  images: ReturnType<typeof toBannerImage>[],
) {
  return {
    id: record.id,
    placement: record.placement,
    layout: record.layout,
    isDefault: record.isDefault,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    images,
  };
}

function toBannerConfigurationSummary(
  record: {
    id: string;
    placement: string;
    layout: BannerLayout;
    isDefault: boolean;
    createdBy: string;
    createdAt: Date;
  },
  imageCount: number,
) {
  return {
    id: record.id,
    placement: record.placement,
    layout: record.layout,
    isDefault: record.isDefault,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    imageCount,
  };
}

function toBannerSchedule(record: {
  id: string;
  bannerConfigurationId: Uuid;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  createdAt: Date;
}) {
  return {
    id: record.id,
    bannerConfigurationId: record.bannerConfigurationId,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
  };
}

export class CmsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly cache?: CacheAdapter,
    private readonly allowedBannerImageHosts: readonly string[] = [],
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
    meta?: ClientMeta,
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
    this.events.emit('cms.page.created', {
      pageId: record.id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    if (record.publishedAt) {
      this.events.emit('cms.page.published', {
        pageId: record.id,
        slug: record.slug,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
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
    meta?: ClientMeta,
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

    this.events.emit('cms.page.updated', {
      pageId: record.id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    const nowPublished = record.publishedAt !== null;
    if (!wasPublished && nowPublished) {
      this.events.emit('cms.page.published', {
        pageId: record.id,
        slug: record.slug,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }

    return toPage(record);
  }

  async deletePage(id: string, actorId: User['id'], meta?: ClientMeta): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(pageTable).where(eq(pageTable.id, id)),
      new PageNotFoundError(id),
    );
    await this.drizzle.db.delete(pageTable).where(eq(pageTable.id, id));
    await invalidate(this.cache, pageCacheKey(existing.slug));
    this.events.emit('cms.page.deleted', {
      pageId: id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true };
  }

  // Every existing placement (default or not), batched (no N+1) across two extra
  // queries regardless of how many placements exist.
  async listPlacements() {
    const [placementRows, defaultRows] = await Promise.all([
      this.drizzle.db
        .selectDistinct({ placement: bannerConfigurationTable.placement })
        .from(bannerConfigurationTable),
      this.drizzle.db
        .select()
        .from(bannerConfigurationTable)
        .where(eq(bannerConfigurationTable.isDefault, true)),
    ]);

    const defaultByPlacement = new Map(defaultRows.map((r) => [r.placement, r]));

    const defaultIds = defaultRows.map((r) => r.id);
    const defaultImages = defaultIds.length
      ? await this.drizzle.db
          .select()
          .from(bannerImageTable)
          .where(inArray(bannerImageTable.bannerConfigurationId, defaultIds))
          .orderBy(asc(bannerImageTable.sortOrder))
      : [];
    const imagesByConfig = new Map<string, typeof defaultImages>();
    for (const image of defaultImages) {
      const list = imagesByConfig.get(image.bannerConfigurationId) ?? [];
      list.push(image);
      imagesByConfig.set(image.bannerConfigurationId, list);
    }

    // Placements with no default use the most recent updatedAt across their
    // (non-default) configurations for the summary timestamp.
    const nonDefaultPlacements = placementRows
      .map((r) => r.placement)
      .filter((p) => !defaultByPlacement.has(p));
    // A raw sql aggregate has no column metadata for Drizzle to decode, so this comes
    // back as Postgres's text representation, not a Date - parse it explicitly.
    const latestUpdatedByPlacement = new Map<string, Date>();
    if (nonDefaultPlacements.length > 0) {
      const rows = await this.drizzle.db
        .select({
          placement: bannerConfigurationTable.placement,
          updatedAt: sql<string>`max(${bannerConfigurationTable.updatedAt})`,
        })
        .from(bannerConfigurationTable)
        .where(inArray(bannerConfigurationTable.placement, nonDefaultPlacements))
        .groupBy(bannerConfigurationTable.placement);
      for (const row of rows) {
        latestUpdatedByPlacement.set(row.placement, new Date(row.updatedAt));
      }
    }

    return placementRows.map(({ placement }) => {
      const defaultRow = defaultByPlacement.get(placement);
      if (defaultRow) {
        return {
          placement,
          defaultConfigurationId: defaultRow.id,
          defaultConfiguration: toBannerConfiguration(
            defaultRow,
            (imagesByConfig.get(defaultRow.id) ?? []).map(toBannerImage),
          ),
          updatedAt: defaultRow.updatedAt.toISOString(),
        };
      }
      const updatedAt = latestUpdatedByPlacement.get(placement) ?? new Date(0);
      return {
        placement,
        defaultConfigurationId: null,
        defaultConfiguration: null,
        updatedAt: updatedAt.toISOString(),
      };
    });
  }

  async listConfigurationsByPlacement(placement: string) {
    const configs = await this.drizzle.db
      .select()
      .from(bannerConfigurationTable)
      .where(eq(bannerConfigurationTable.placement, placement))
      .orderBy(desc(bannerConfigurationTable.createdAt));

    const ids = configs.map((c) => c.id);
    const counts = ids.length
      ? await this.drizzle.db
          .select({
            bannerConfigurationId: bannerImageTable.bannerConfigurationId,
            count: sql<number>`count(*)::int`,
          })
          .from(bannerImageTable)
          .where(inArray(bannerImageTable.bannerConfigurationId, ids))
          .groupBy(bannerImageTable.bannerConfigurationId)
      : [];
    const countByConfig = new Map(counts.map((c) => [c.bannerConfigurationId, c.count]));

    return configs.map((record) =>
      toBannerConfigurationSummary(record, countByConfig.get(record.id) ?? 0),
    );
  }

  async getConfiguration(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(bannerConfigurationTable)
        .where(eq(bannerConfigurationTable.id, id)),
      new BannerConfigurationNotFoundError(id),
    );
    const images = await this.drizzle.db
      .select()
      .from(bannerImageTable)
      .where(eq(bannerImageTable.bannerConfigurationId, id))
      .orderBy(asc(bannerImageTable.sortOrder));
    return toBannerConfiguration(record, images.map(toBannerImage));
  }

  async createConfiguration(
    input: { placement: string; layout: BannerLayout },
    actorId: User['id'],
    meta?: ClientMeta,
  ) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .insert(bannerConfigurationTable)
        .values({
          placement: input.placement,
          layout: input.layout,
          isDefault: false,
          createdBy: actorId,
        })
        .returning(),
      new BannerConfigurationNotFoundError(input.placement),
    );
    this.events.emit('cms.banner.configuration.created', {
      bannerConfigurationId: record.id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return toBannerConfiguration(record, []);
  }

  async deleteConfiguration(
    id: string,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<{ success: true }> {
    await this.drizzle.db.transaction(async (tx) => {
      const existing = findOneOrThrow(
        await tx.select().from(bannerConfigurationTable).where(eq(bannerConfigurationTable.id, id)),
        new BannerConfigurationNotFoundError(id),
      );
      if (existing.isDefault) {
        throw new BannerConfigurationIsDefaultError();
      }
      // Blocked unconditionally (queued, active, or expired) - no live-time
      // computation in this guard, see D4 in the scheduling design.
      const [schedule] = await tx
        .select({ id: bannerScheduleTable.id })
        .from(bannerScheduleTable)
        .where(eq(bannerScheduleTable.bannerConfigurationId, id));
      if (schedule) {
        throw new BannerConfigurationHasScheduleError();
      }
      // Cascades to banner_image rows via the FK's onDelete: 'cascade'.
      await tx.delete(bannerConfigurationTable).where(eq(bannerConfigurationTable.id, id));
    });
    this.events.emit('cms.banner.configuration.deleted', {
      bannerConfigurationId: id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true };
  }

  async setDefaultConfiguration(id: string, actorId: User['id'], meta?: ClientMeta) {
    const placement = await this.drizzle.db.transaction(async (tx) => {
      const initialConfig = findOneOrThrow(
        await tx.select().from(bannerConfigurationTable).where(eq(bannerConfigurationTable.id, id)),
        new BannerConfigurationNotFoundError(id),
      );
      return withAdvisoryXactLock(tx, bannerScheduleLockKey(initialConfig.placement), async () => {
        const config = findOneOrThrow(
          await tx
            .select()
            .from(bannerConfigurationTable)
            .where(eq(bannerConfigurationTable.id, id)),
          new BannerConfigurationNotFoundError(id),
        );
        const [schedule] = await tx
          .select({ id: bannerScheduleTable.id })
          .from(bannerScheduleTable)
          .where(eq(bannerScheduleTable.bannerConfigurationId, id));
        if (schedule) {
          throw new BannerConfigurationHasScheduleError();
        }
        await this.assertBannerConfigurationImageCount(tx, config);

        await tx
          .update(bannerConfigurationTable)
          .set({ isDefault: false })
          .where(
            and(
              eq(bannerConfigurationTable.placement, config.placement),
              eq(bannerConfigurationTable.isDefault, true),
            ),
          );
        await tx
          .update(bannerConfigurationTable)
          .set({ isDefault: true })
          .where(eq(bannerConfigurationTable.id, id));

        return config.placement;
      });
    });

    await invalidate(this.cache, publicBannerCacheKey(placement, DEFAULT_LOCALE));
    this.events.emit('cms.banner.configuration.set_default', {
      bannerConfigurationId: id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return this.getPlacementSummary(placement);
  }

  async unsetDefaultConfiguration(placement: string, actorId: User['id'], meta?: ClientMeta) {
    const previousBannerConfigurationId = await this.drizzle.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(bannerConfigurationTable)
        .where(
          and(
            eq(bannerConfigurationTable.placement, placement),
            eq(bannerConfigurationTable.isDefault, true),
          ),
        );
      if (!current) {
        return null;
      }
      await tx
        .update(bannerConfigurationTable)
        .set({ isDefault: false })
        .where(eq(bannerConfigurationTable.id, current.id));
      return current.id;
    });

    await invalidate(this.cache, publicBannerCacheKey(placement, DEFAULT_LOCALE));
    this.events.emit('cms.banner.configuration.unset_default', {
      placement,
      previousBannerConfigurationId,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return this.getPlacementSummary(placement);
  }

  async setBannerImage(
    input: {
      bannerConfigurationId: Uuid;
      sortOrder: number;
      locale?: string;
      desktopImageUrl: string;
      mobileImageUrl: string;
      linkUrl?: string | null;
    },
    actorId: User['id'],
    meta?: ClientMeta,
  ) {
    for (const url of [input.desktopImageUrl, input.mobileImageUrl]) {
      const result = validateBannerImageUrl(url, this.allowedBannerImageHosts);
      if (!result.ok) {
        throw new BannerImageHostNotAllowedError(result.reason);
      }
    }

    const configuration = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(bannerConfigurationTable)
        .where(eq(bannerConfigurationTable.id, input.bannerConfigurationId)),
      new BannerConfigurationNotFoundError(input.bannerConfigurationId),
    );

    const locale = input.locale ?? DEFAULT_LOCALE;
    const record = findOneOrThrow(
      await this.drizzle.db
        .insert(bannerImageTable)
        .values({
          bannerConfigurationId: input.bannerConfigurationId,
          sortOrder: input.sortOrder,
          locale,
          desktopImageUrl: input.desktopImageUrl,
          mobileImageUrl: input.mobileImageUrl,
          linkUrl: input.linkUrl ?? null,
        })
        .onConflictDoUpdate({
          target: [
            bannerImageTable.bannerConfigurationId,
            bannerImageTable.sortOrder,
            bannerImageTable.locale,
          ],
          set: {
            desktopImageUrl: input.desktopImageUrl,
            mobileImageUrl: input.mobileImageUrl,
            linkUrl: input.linkUrl ?? null,
          },
        })
        .returning(),
      new BannerConfigurationNotFoundError(input.bannerConfigurationId),
    );

    if (configuration.isDefault) {
      await invalidate(this.cache, publicBannerCacheKey(configuration.placement, DEFAULT_LOCALE));
    }

    this.events.emit('cms.banner.image.set', {
      bannerImageId: record.id,
      bannerConfigurationId: input.bannerConfigurationId,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return toBannerImage(record);
  }

  async deleteBannerImage(
    id: string,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db
        .select({
          id: bannerImageTable.id,
          bannerConfigurationId: bannerImageTable.bannerConfigurationId,
        })
        .from(bannerImageTable)
        .where(eq(bannerImageTable.id, id)),
      new BannerImageNotFoundError(id),
    );

    await this.drizzle.db.delete(bannerImageTable).where(eq(bannerImageTable.id, id));

    const [configuration] = await this.drizzle.db
      .select({
        placement: bannerConfigurationTable.placement,
        isDefault: bannerConfigurationTable.isDefault,
      })
      .from(bannerConfigurationTable)
      .where(eq(bannerConfigurationTable.id, existing.bannerConfigurationId));
    if (configuration?.isDefault) {
      await invalidate(this.cache, publicBannerCacheKey(configuration.placement, DEFAULT_LOCALE));
    }

    this.events.emit('cms.banner.image.deleted', {
      bannerImageId: id,
      bannerConfigurationId: existing.bannerConfigurationId,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true };
  }

  async getPublicBanner(placement: string, locale?: string) {
    const resolvedLocale = locale ?? DEFAULT_LOCALE;
    return cached(
      this.cache,
      publicBannerCacheKey(placement, resolvedLocale),
      CMS_CACHE_TTL_MS,
      async () => {
        // "What's live" is resolved here, at read time, not by a background job - a
        // scheduled banner wins over the default while now() falls inside its
        // [startsAt, endsAt] window (same auto-expiry approach as rgExclusion, see
        // compliance/schema/index.ts). No invalidation is needed at the schedule's
        // own start/end boundary; the pre-existing CMS_CACHE_TTL_MS bounds the lag.
        const now = new Date();
        const [scheduled] = await this.drizzle.db
          .select({
            id: bannerConfigurationTable.id,
            layout: bannerConfigurationTable.layout,
          })
          .from(bannerScheduleTable)
          .innerJoin(
            bannerConfigurationTable,
            eq(bannerConfigurationTable.id, bannerScheduleTable.bannerConfigurationId),
          )
          .where(
            and(
              eq(bannerConfigurationTable.placement, placement),
              lte(bannerScheduleTable.startsAt, now),
              gte(bannerScheduleTable.endsAt, now),
            ),
          )
          .limit(1);

        const activeConfig =
          scheduled ??
          (
            await this.drizzle.db
              .select({
                id: bannerConfigurationTable.id,
                layout: bannerConfigurationTable.layout,
              })
              .from(bannerConfigurationTable)
              .where(
                and(
                  eq(bannerConfigurationTable.placement, placement),
                  eq(bannerConfigurationTable.isDefault, true),
                ),
              )
          )[0];

        if (!activeConfig) {
          return null;
        }

        const images = await this.drizzle.db
          .select()
          .from(bannerImageTable)
          .where(eq(bannerImageTable.bannerConfigurationId, activeConfig.id))
          .orderBy(asc(bannerImageTable.sortOrder));

        const localeRowBySlot = new Map(
          images.filter((i) => i.locale === resolvedLocale).map((i) => [i.sortOrder, i]),
        );
        const baseRows = images.filter((i) => i.locale === DEFAULT_LOCALE);

        const slots = baseRows
          .map((base) => {
            const resolved = localeRowBySlot.get(base.sortOrder) ?? base;
            return {
              sortOrder: base.sortOrder,
              desktopImageUrl: resolved.desktopImageUrl,
              mobileImageUrl: resolved.mobileImageUrl,
              linkUrl: resolved.linkUrl,
            };
          })
          .sort((a, b) => a.sortOrder - b.sortOrder);

        return { placement, layout: activeConfig.layout, slots };
      },
    );
  }

  async createBannerSchedule(
    bannerConfigurationId: Uuid,
    input: { startsAt: string; endsAt: string },
    actorId: User['id'],
    meta?: ClientMeta,
  ) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);

    const { record, placement } = await this.drizzle.db.transaction(async (tx) => {
      const initialConfig = findOneOrThrow(
        await tx
          .select()
          .from(bannerConfigurationTable)
          .where(eq(bannerConfigurationTable.id, bannerConfigurationId)),
        new BannerConfigurationNotFoundError(bannerConfigurationId),
      );
      return withAdvisoryXactLock(tx, bannerScheduleLockKey(initialConfig.placement), async () => {
        const config = findOneOrThrow(
          await tx
            .select()
            .from(bannerConfigurationTable)
            .where(eq(bannerConfigurationTable.id, bannerConfigurationId)),
          new BannerConfigurationNotFoundError(bannerConfigurationId),
        );
        // A schedule requires a default to layer onto, and can never target the
        // default configuration itself (it is already live).
        if (config.isDefault) {
          throw new BannerConfigurationIsDefaultError();
        }
        const [defaultConfig] = await tx
          .select({ id: bannerConfigurationTable.id })
          .from(bannerConfigurationTable)
          .where(
            and(
              eq(bannerConfigurationTable.placement, config.placement),
              eq(bannerConfigurationTable.isDefault, true),
            ),
          );
        if (!defaultConfig) {
          throw new BannerConfigurationNotFoundError(config.placement);
        }

        const [existingSchedule] = await tx
          .select({ id: bannerScheduleTable.id })
          .from(bannerScheduleTable)
          .where(eq(bannerScheduleTable.bannerConfigurationId, bannerConfigurationId));
        if (existingSchedule) {
          throw new BannerConfigurationHasScheduleError();
        }

        if (endsAt <= startsAt) {
          throw new BannerScheduleInvalidRangeError('endsAt must be after startsAt');
        }
        if (startsAt <= new Date()) {
          throw new BannerScheduleInvalidRangeError('startsAt must be in the future');
        }
        await this.assertBannerConfigurationImageCount(tx, config);
        await this.assertNoScheduleOverlap(tx, config.placement, bannerConfigurationId, {
          startsAt,
          endsAt,
        });

        const inserted = findOneOrThrow(
          await tx
            .insert(bannerScheduleTable)
            .values({ bannerConfigurationId, startsAt, endsAt, createdBy: actorId })
            .returning(),
          new BannerConfigurationNotFoundError(bannerConfigurationId),
        );
        return { record: inserted, placement: config.placement };
      });
    });

    await invalidate(this.cache, publicBannerCacheKey(placement, DEFAULT_LOCALE));
    this.events.emit('cms.banner.schedule.created', {
      bannerScheduleId: record.id,
      bannerConfigurationId,
      placement,
      startsAt: record.startsAt.toISOString(),
      endsAt: record.endsAt.toISOString(),
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return toBannerSchedule(record);
  }

  async updateBannerScheduleEnd(
    bannerConfigurationId: Uuid,
    input: { endsAt: string },
    actorId: User['id'],
    meta?: ClientMeta,
  ) {
    const newEndsAt = new Date(input.endsAt);

    const { record, placement, previousEndsAt } = await this.drizzle.db.transaction(async (tx) => {
      const initialConfig = findOneOrThrow(
        await tx
          .select()
          .from(bannerConfigurationTable)
          .where(eq(bannerConfigurationTable.id, bannerConfigurationId)),
        new BannerConfigurationNotFoundError(bannerConfigurationId),
      );
      return withAdvisoryXactLock(tx, bannerScheduleLockKey(initialConfig.placement), async () => {
        const config = findOneOrThrow(
          await tx
            .select()
            .from(bannerConfigurationTable)
            .where(eq(bannerConfigurationTable.id, bannerConfigurationId)),
          new BannerConfigurationNotFoundError(bannerConfigurationId),
        );
        const schedule = findOneOrThrow(
          await tx
            .select()
            .from(bannerScheduleTable)
            .where(eq(bannerScheduleTable.bannerConfigurationId, bannerConfigurationId)),
          new BannerScheduleNotFoundError(bannerConfigurationId),
        );

        if (newEndsAt <= schedule.startsAt) {
          throw new BannerScheduleInvalidRangeError('endsAt must be after startsAt');
        }
        // startsAt is not editable and not re-validated against now() here - ending a
        // schedule early legitimately moves endsAt to now or the past.

        await this.assertNoScheduleOverlap(tx, config.placement, bannerConfigurationId, {
          startsAt: schedule.startsAt,
          endsAt: newEndsAt,
        });

        const updated = findOneOrThrow(
          await tx
            .update(bannerScheduleTable)
            .set({ endsAt: newEndsAt })
            .where(eq(bannerScheduleTable.id, schedule.id))
            .returning(),
          new BannerScheduleNotFoundError(bannerConfigurationId),
        );
        return { record: updated, placement: config.placement, previousEndsAt: schedule.endsAt };
      });
    });

    await invalidate(this.cache, publicBannerCacheKey(placement, DEFAULT_LOCALE));
    this.events.emit('cms.banner.schedule.updated', {
      bannerScheduleId: record.id,
      bannerConfigurationId,
      placement,
      startsAt: record.startsAt.toISOString(),
      endsAt: record.endsAt.toISOString(),
      before: { endsAt: previousEndsAt.toISOString() },
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return toBannerSchedule(record);
  }

  async listBannerSchedulesByPlacement(placement: string) {
    const rows = await this.drizzle.db
      .select({ schedule: bannerScheduleTable, configuration: bannerConfigurationTable })
      .from(bannerScheduleTable)
      .innerJoin(
        bannerConfigurationTable,
        eq(bannerConfigurationTable.id, bannerScheduleTable.bannerConfigurationId),
      )
      .where(eq(bannerConfigurationTable.placement, placement))
      .orderBy(asc(bannerScheduleTable.startsAt));

    const configIds = rows.map((r) => r.configuration.id);
    const counts = configIds.length
      ? await this.drizzle.db
          .select({
            bannerConfigurationId: bannerImageTable.bannerConfigurationId,
            count: sql<number>`count(*)::int`,
          })
          .from(bannerImageTable)
          .where(inArray(bannerImageTable.bannerConfigurationId, configIds))
          .groupBy(bannerImageTable.bannerConfigurationId)
      : [];
    const countByConfig = new Map(counts.map((c) => [c.bannerConfigurationId, c.count]));

    return rows.map((r) => ({
      ...toBannerSchedule(r.schedule),
      configuration: toBannerConfigurationSummary(
        r.configuration,
        countByConfig.get(r.configuration.id) ?? 0,
      ),
    }));
  }

  // Half-open interval overlap: an existing schedule on the same placement (excluding
  // the target configuration itself) conflicts unless it ends at-or-before the new
  // start or starts at-or-after the new end - so touching boundaries are allowed.
  private async assertNoScheduleOverlap(
    tx: DrizzleTx,
    placement: string,
    excludeBannerConfigurationId: Uuid,
    range: { startsAt: Date; endsAt: Date },
  ) {
    const [conflict] = await tx
      .select({ startsAt: bannerScheduleTable.startsAt, endsAt: bannerScheduleTable.endsAt })
      .from(bannerScheduleTable)
      .innerJoin(
        bannerConfigurationTable,
        eq(bannerConfigurationTable.id, bannerScheduleTable.bannerConfigurationId),
      )
      .where(
        and(
          eq(bannerConfigurationTable.placement, placement),
          ne(bannerScheduleTable.bannerConfigurationId, excludeBannerConfigurationId),
          gt(bannerScheduleTable.endsAt, range.startsAt),
          lt(bannerScheduleTable.startsAt, range.endsAt),
        ),
      )
      .limit(1);
    if (conflict) {
      throw new BannerScheduleOverlapError(conflict.startsAt, conflict.endsAt);
    }
  }

  private async assertBannerConfigurationImageCount(
    tx: DrizzleTx,
    configuration: { id: Uuid; layout: BannerLayout },
  ) {
    // Slot count is measured against base-locale rows only: locale overrides replace
    // a slot rather than adding a publishable slot.
    const slotRows = await tx
      .select({ sortOrder: bannerImageTable.sortOrder })
      .from(bannerImageTable)
      .where(
        and(
          eq(bannerImageTable.bannerConfigurationId, configuration.id),
          eq(bannerImageTable.locale, DEFAULT_LOCALE),
        ),
      );
    const slotCount = new Set(slotRows.map((row) => row.sortOrder)).size;
    const bounds = BANNER_IMAGE_COUNT_BOUNDS[configuration.layout];
    if (slotCount < bounds.min || slotCount > bounds.max) {
      throw new BannerConfigurationImageCountError(
        configuration.layout,
        bounds.min,
        bounds.max,
        slotCount,
      );
    }
  }

  // Shared by setDefaultConfiguration/unsetDefaultConfiguration - single-placement,
  // so the extra queries here are not the N+1 pattern listPlacements avoids.
  private async getPlacementSummary(placement: string) {
    const [defaultRow] = await this.drizzle.db
      .select()
      .from(bannerConfigurationTable)
      .where(
        and(
          eq(bannerConfigurationTable.placement, placement),
          eq(bannerConfigurationTable.isDefault, true),
        ),
      );

    if (defaultRow) {
      const images = await this.drizzle.db
        .select()
        .from(bannerImageTable)
        .where(eq(bannerImageTable.bannerConfigurationId, defaultRow.id))
        .orderBy(asc(bannerImageTable.sortOrder));
      return {
        placement,
        defaultConfigurationId: defaultRow.id,
        defaultConfiguration: toBannerConfiguration(defaultRow, images.map(toBannerImage)),
        updatedAt: defaultRow.updatedAt.toISOString(),
      };
    }

    // A raw sql aggregate has no column metadata for Drizzle to decode, so this comes
    // back as Postgres's text representation, not a Date - parse it explicitly.
    const [latest] = await this.drizzle.db
      .select({ updatedAt: sql<string | null>`max(${bannerConfigurationTable.updatedAt})` })
      .from(bannerConfigurationTable)
      .where(eq(bannerConfigurationTable.placement, placement));

    return {
      placement,
      defaultConfigurationId: null,
      defaultConfiguration: null,
      updatedAt: (latest?.updatedAt ? new Date(latest.updatedAt) : new Date()).toISOString(),
    };
  }
}
