import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { BANNER_LAYOUTS, DEFAULT_LOCALE } from '../contract/index.js';

export const page = pgTable('page', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  content: jsonb().notNull().default({}),
  publishedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const bannerLayout = pgEnum('banner_layout', BANNER_LAYOUTS);

export const bannerConfiguration = pgTable(
  'banner_configuration',
  {
    id: uuid().primaryKey().defaultRandom(),
    placement: text().notNull(),
    layout: bannerLayout().notNull(),
    isDefault: boolean().notNull().default(false),
    createdBy: uuid().notNull(), // bare id - cross-module (user from pam/identity), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('banner_configuration_placement_idx').on(t.placement),
    // At most one default (= "live") configuration per placement.
    uniqueIndex('banner_configuration_default_per_placement_idx')
      .on(t.placement)
      .where(sql`${t.isDefault} = true`),
  ],
);

export const bannerImage = pgTable(
  'banner_image',
  {
    id: uuid().primaryKey().defaultRandom(),
    bannerConfigurationId: uuid()
      .notNull()
      .references(() => bannerConfiguration.id, { onDelete: 'cascade' }),
    sortOrder: integer().notNull(),
    locale: text().notNull().default(DEFAULT_LOCALE),
    desktopImageUrl: text().notNull(),
    mobileImageUrl: text().notNull(),
    linkUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('banner_image_configuration_sort_locale_idx').on(
      t.bannerConfigurationId,
      t.sortOrder,
      t.locale,
    ),
    index('banner_image_configuration_id_idx').on(t.bannerConfigurationId),
  ],
);

// 1:0..1 with bannerConfiguration - a configuration is either the standing default
// (isDefault=true, no schedule row), a scheduled banner (isDefault=false, exactly one
// schedule row), or an unconfigured draft. Read-time resolution only ("what's live" is
// computed in getPublicBanner by comparing now against startsAt/endsAt), same as
// rgExclusion's auto-expiry (see compliance/schema/index.ts) - no background job.
export const bannerSchedule = pgTable(
  'banner_schedule',
  {
    id: uuid().primaryKey().defaultRandom(),
    bannerConfigurationId: uuid()
      .notNull()
      .references(() => bannerConfiguration.id, { onDelete: 'cascade' }),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    createdBy: uuid().notNull(), // bare id - cross-module (user from pam/identity), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    // 1:0..1 with bannerConfiguration - at most one schedule row per configuration.
    uniqueIndex('banner_schedule_configuration_id_idx').on(t.bannerConfigurationId),
    index('banner_schedule_starts_ends_idx').on(t.startsAt, t.endsAt),
    check('banner_schedule_ends_after_starts_check', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export type Page = typeof page.$inferSelect;
export type BannerConfiguration = typeof bannerConfiguration.$inferSelect;
export type BannerImage = typeof bannerImage.$inferSelect;
export type BannerSchedule = typeof bannerSchedule.$inferSelect;
