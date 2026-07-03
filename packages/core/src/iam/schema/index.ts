import { invitationStatuses } from '@blurifycom/core/contracts';
import {
  boolean,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const invitationStatusEnum = pgEnum('invitation_status', invitationStatuses);

export const adminRole = pgTable(
  'admin_role',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Stable slug for predefined roles; null for operator-created roles.
    // In Postgres NULL != NULL, so this unique index only deduplicates predefined slugs.
    key: text(),
    // English fallback label; operators set it for custom roles. Localized display
    // copy for predefined roles is resolved by `key` in the consumer (i18n), not stored.
    name: text().notNull(),
    // System roles cannot be deleted; super-admin roles bypass all authz checks and cannot be stripped.
    isSystem: boolean().notNull().default(false),
    isSuperAdmin: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_role_key_uq').on(t.key)],
);

export const adminRolePermission = pgTable(
  'admin_role_permission',
  {
    id: uuid().primaryKey().defaultRandom(),
    roleId: uuid().notNull(),
    resource: text().notNull(),
    // Sparse storage: absence of a row means `no_access`. The DEFAULT exists only to make
    // ALTER TABLE ADD COLUMN safe on a populated table; the code never writes no_access rows.
    level: text({ enum: ['no_access', 'read', 'read_write'] })
      .notNull()
      .default('no_access'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_permission_role_id_idx').on(t.roleId),
    uniqueIndex('admin_role_permission_role_resource_uq').on(t.roleId, t.resource),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }).onDelete('cascade'),
  ],
);

export const adminRoleAssignment = pgTable(
  'admin_role_assignment',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    roleId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_role_assignment_user_id_idx').on(t.userId),
    uniqueIndex('admin_role_assignment_uq').on(t.userId, t.roleId),
    foreignKey({ columns: [t.roleId], foreignColumns: [adminRole.id] }).onDelete('cascade'),
  ],
);

export const adminInvitation = pgTable(
  'admin_invitation',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    roleId: uuid().notNull(),
    token: text().notNull().unique(),
    status: invitationStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
