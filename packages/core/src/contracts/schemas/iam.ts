import * as z from 'zod';

export const permissionLevels = ['no_access', 'read', 'read_write'] as const;
export const PermissionLevelSchema = z.enum(permissionLevels);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const invitationStatuses = ['pending', 'accepted', 'revoked'] as const;
export const InvitationStatusSchema = z.enum(invitationStatuses);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

// Closed set of values the better-auth `user.role` column legitimately holds.
// Shared here so the adapter port (contracts) and consumer contracts never duplicate it.
export const userRoles = ['player', 'admin'] as const;
export const UserRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRoleSchema>;
