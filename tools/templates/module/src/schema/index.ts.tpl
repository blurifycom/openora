import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

// Drizzle tables owned by the {{Name}} module.
// Rules:
//   - Every multi-tenant table includes a `tenantId` column.
//   - Do not add FK references to tables owned by other modules - use IDs.
//   - Table names are snake_case; exported consts are camelCase.
export const {{camel}} = pgTable('{{table}}', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tenantId: text('tenantId').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (t) => [index('{{table}}_tenantId_idx').on(t.tenantId)]);

export type {{Name}} = typeof {{camel}}.$inferSelect;
