import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const page = pgTable('page', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  content: jsonb().notNull().default({}),
  publishedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const banner = pgTable(
  'banner',
  {
    id: uuid().primaryKey().defaultRandom(),
    placement: text().notNull(),
    title: text().notNull(),
    imageUrl: text().notNull(),
    linkUrl: text(),
    isActive: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('banner_placement_is_active_idx').on(t.placement, t.isActive)],
);

export type Page = typeof page.$inferSelect;
export type Banner = typeof banner.$inferSelect;
