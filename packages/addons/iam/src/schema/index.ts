import { pgTable, text, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const adminRole = pgTable(
  'admin_role',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [index('admin_role_tenantId_idx').on(t.tenantId)],
);

export const adminRolePermission = pgTable(
  'admin_role_permission',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    roleId: text('roleId').notNull(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_permission_roleId_idx').on(t.roleId),
    index('admin_role_permission_tenantId_roleId_idx').on(t.tenantId, t.roleId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export const adminRoleAssignment = pgTable(
  'admin_role_assignment',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    // Reference to identity user by id - no cross-module FK.
    userId: text('userId').notNull(),
    roleId: text('roleId').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_assignment_tenantId_userId_idx').on(t.tenantId, t.userId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export const adminInvitation = pgTable(
  'admin_invitation',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    email: text('email').notNull(),
    roleId: text('roleId').notNull(),
    token: text('token').notNull().unique(),
    status: text('status', { enum: ['pending', 'accepted', 'revoked'] })
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expiresAt').notNull(),
    acceptedAt: timestamp('acceptedAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('admin_invitation_tenantId_idx').on(t.tenantId),
    index('admin_invitation_token_idx').on(t.token),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }),
  ],
);

export type AdminRole = typeof adminRole.$inferSelect;
export type AdminRolePermission = typeof adminRolePermission.$inferSelect;
export type AdminRoleAssignment = typeof adminRoleAssignment.$inferSelect;
export type AdminInvitation = typeof adminInvitation.$inferSelect;
