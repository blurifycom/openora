import { pgTable, uuid, text, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';

export const adminRole = pgTable('admin_role', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export const adminRolePermission = pgTable(
  'admin_role_permission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('roleId').notNull(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_permission_roleId_idx').on(t.roleId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export const adminRoleAssignment = pgTable(
  'admin_role_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Reference to identity user by id - no cross-module FK.
    userId: uuid('userId').notNull(),
    roleId: uuid('roleId').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_assignment_userId_idx').on(t.userId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export const adminInvitation = pgTable(
  'admin_invitation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    roleId: uuid('roleId').notNull(),
    token: text('token').notNull().unique(),
    status: text('status', { enum: ['pending', 'accepted', 'revoked'] })
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expiresAt').notNull(),
    acceptedAt: timestamp('acceptedAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_invitation_token_idx').on(t.token),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export type AdminRole = typeof adminRole.$inferSelect;
export type AdminRolePermission = typeof adminRolePermission.$inferSelect;
export type AdminRoleAssignment = typeof adminRoleAssignment.$inferSelect;
export type AdminInvitation = typeof adminInvitation.$inferSelect;
