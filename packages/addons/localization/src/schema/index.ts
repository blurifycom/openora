import { pgTable, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const locale = pgTable('locale', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  isDefault: boolean('isDefault').notNull().default(false),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export const translation = pgTable(
  'translation',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    localeId: text('localeId')
      .notNull()
      .references(() => locale.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('translation_localeId_namespace_key_key').on(t.localeId, t.namespace, t.key)],
);

export type Locale = typeof locale.$inferSelect;
export type Translation = typeof translation.$inferSelect;
