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

// Admin RBAC catalog. It lives in contracts, not in `server/auth`, because the
// backoffice gates its navigation, its routes and its query hooks on the same
// resource names that AdminGuard asserts, and a browser bundle cannot import
// from `server/`. Without one shared source each consumer retypes the list, and
// a typo resolves silently to "no grant" instead of failing the build.
export const adminStatement = {
  player: ['view', 'update', 'ban'] as const,
  transaction: ['view', 'refund'] as const,
  game: ['view', 'enable', 'disable'] as const,
  content: ['create', 'update', 'delete', 'publish'] as const,
  compliance: ['view', 'override-limit', 'manage-rg'] as const,
  report: ['view'] as const,
  withdrawal: ['view', 'approve', 'reject', 'hold', 'auto-rule'] as const,
  bonus: ['view', 'create', 'update', 'pause', 'cancel'] as const,
  audit: ['view', 'export'] as const,
  admin: ['view', 'create', 'update', 'disable', 'delete'] as const,
  'game-config': ['view', 'update', 'schedule'] as const,
  analytics: ['view'] as const,
  sportsbook: ['view', 'configure', 'suspend'] as const,
  affiliate: ['view', 'manage'] as const,
  sessions: ['view', 'revoke'] as const,
  'player-note': ['view', 'create'] as const,
  'tag-rule': ['view', 'update'] as const,
  tag: ['view', 'create', 'delete'] as const,
  'chat-room': ['view', 'create', 'update', 'delete'] as const,
  'auto-withdrawal-config': ['view', 'update'] as const,
  'bonus-rollover-config': ['view', 'update'] as const,
  'wallet-asset': ['view', 'create', 'update', 'delete'] as const,
  'wallet-custody': ['view', 'run'] as const,
  'wallet-reconciliation': ['view', 'resolve', 'run'] as const,
  'chat-command': ['view', 'update'] as const,
  'chat-moderation': ['view', 'moderate'] as const,
} as const;

export type AdminResource = keyof typeof adminStatement;
export type AdminActionOf<R extends AdminResource> = (typeof adminStatement)[R][number];
