import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';

export const adminRole = pgTable(
  'admin_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable slug for predefined roles; null for operator-created roles.
    // In Postgres NULL != NULL, so this unique index only deduplicates predefined slugs.
    key: text('key'),
    name: text('name').notNull(),
    description: text('description'),
    // System roles cannot be deleted; super-admin roles bypass all authz checks and cannot be stripped.
    isSystem: boolean('isSystem').notNull().default(false),
    isSuperAdmin: boolean('isSuperAdmin').notNull().default(false),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_role_key_uq').on(t.key)],
);

export const adminRolePermission = pgTable(
  'admin_role_permission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('roleId').notNull(),
    resource: text('resource').notNull(),
    // Sparse storage: absence of a row means `no_access`. The DEFAULT exists only to make
    // ALTER TABLE ADD COLUMN safe on a populated table; the code never writes no_access rows.
    level: text('level', { enum: ['no_access', 'read', 'read_write'] })
      .notNull()
      .default('no_access'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_permission_roleId_idx').on(t.roleId),
    uniqueIndex('admin_role_permission_role_resource_uq').on(t.roleId, t.resource),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }).onDelete('cascade'),
  ],
);

export const adminRoleAssignment = pgTable(
  'admin_role_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId').notNull(),
    roleId: uuid('roleId').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_assignment_userId_idx').on(t.userId),
    uniqueIndex('admin_role_assignment_uq').on(t.userId, t.roleId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }).onDelete('cascade'),
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
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('acceptedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_invitation_token_idx').on(t.token),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }).onDelete('cascade'),
  ],
);

export type AdminRole = typeof adminRole.$inferSelect;
export type AdminRolePermission = typeof adminRolePermission.$inferSelect;
export type AdminRoleAssignment = typeof adminRoleAssignment.$inferSelect;
export type AdminInvitation = typeof adminInvitation.$inferSelect;
