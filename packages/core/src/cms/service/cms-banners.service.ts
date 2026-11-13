import { and, asc, count, desc, eq, gte, inArray, lte, notExists, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DrizzleService } from '@openora/core/server';
import {
  CMS_BANNERS_MAX,
  CMS_BANNER_MAX_LOCALES,
  type CmsBanners,
  type CmsBannersInput,
} from '../contract/index.js';
import { bannerConfiguration, bannerImage, bannerSchedule } from '../schema/index.js';

const config = bannerConfiguration;
const placementSchedule = alias(bannerSchedule, 'placement_schedule');
const placementConfig = alias(bannerConfiguration, 'placement_config');

/**
 * The banner configurations as an agent reads them, with what each placement shows now resolved
 * the way the public banner read resolves it: a schedule covering now wins over the default.
 */
export class CmsBannersService {
  constructor(private readonly drizzle: DrizzleService) {}

  async banners({ placement }: CmsBannersInput, now = new Date()): Promise<CmsBanners> {
    const db = this.drizzle.db;
    const coversNow = (schedule: { startsAt: AnyPgColumn; endsAt: AnyPgColumn }) =>
      and(lte(schedule.startsAt, now), gte(schedule.endsAt, now));
    const placementScheduledNow = db
      .select({ one: sql`1` })
      .from(placementSchedule)
      .innerJoin(placementConfig, eq(placementConfig.id, placementSchedule.bannerConfigurationId))
      .where(and(eq(placementConfig.placement, config.placement), coversNow(placementSchedule)));
    const rows = await db
      .select({
        bannerId: config.id,
        placement: config.placement,
        layout: config.layout,
        isDefault: config.isDefault,
        liveNow: sql<boolean>`coalesce(${or(
          coversNow(bannerSchedule),
          and(eq(config.isDefault, true), notExists(placementScheduledNow)),
        )}, false)`,
        startsAt: bannerSchedule.startsAt,
      })
      .from(config)
      .leftJoin(bannerSchedule, eq(bannerSchedule.bannerConfigurationId, config.id))
      .where(placement ? eq(config.placement, placement) : undefined)
      .orderBy(
        asc(config.placement),
        desc(config.isDefault),
        desc(config.createdAt),
        asc(config.id),
      )
      .limit(CMS_BANNERS_MAX + 1);
    const page = rows.slice(0, CMS_BANNERS_MAX);
    const imagesOf = await this.images(page.map((row) => row.bannerId));
    return {
      banners: page.map(({ startsAt, ...row }) => ({
        ...row,
        imageCount: imagesOf.get(row.bannerId)?.count ?? 0,
        locales: imagesOf.get(row.bannerId)?.locales ?? [],
        nextStartsAt: startsAt && startsAt > now ? startsAt.toISOString() : null,
      })),
      truncated: rows.length > CMS_BANNERS_MAX,
    };
  }

  /** How many images each configuration holds, and the locales they are in. */
  private async images(ids: readonly string[]) {
    const byConfiguration = new Map<string, { count: number; locales: string[] }>();
    if (ids.length === 0) {
      return byConfiguration;
    }
    const rows = await this.drizzle.db
      .select({
        bannerConfigurationId: bannerImage.bannerConfigurationId,
        locale: bannerImage.locale,
        count: count(),
      })
      .from(bannerImage)
      .where(inArray(bannerImage.bannerConfigurationId, [...ids]))
      .groupBy(bannerImage.bannerConfigurationId, bannerImage.locale)
      .orderBy(asc(bannerImage.locale));
    for (const { bannerConfigurationId, locale, count: images } of rows) {
      const held = byConfiguration.get(bannerConfigurationId) ?? { count: 0, locales: [] };
      byConfiguration.set(bannerConfigurationId, {
        count: held.count + images,
        locales:
          held.locales.length < CMS_BANNER_MAX_LOCALES ? [...held.locales, locale] : held.locales,
      });
    }
    return byConfiguration;
  }
}
