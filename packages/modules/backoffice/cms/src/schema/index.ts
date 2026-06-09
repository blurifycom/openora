import { pgTable, text, boolean, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const page = pgTable('page', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  content: jsonb('content').notNull().default({}),
  publishedAt: timestamp('publishedAt'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const banner = pgTable(
  'banner',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    placement: text('placement').notNull(),
    title: text('title').notNull(),
    imageUrl: text('imageUrl').notNull(),
    linkUrl: text('linkUrl'),
    isActive: boolean('isActive').notNull().default(true),
    sortOrder: integer('sortOrder').notNull().default(0),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('banner_placement_isActive_idx').on(t.placement, t.isActive)],
);

export type Page = typeof page.$inferSelect;
export type Banner = typeof banner.$inferSelect;
