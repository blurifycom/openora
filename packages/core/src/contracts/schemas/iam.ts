import * as z from 'zod';

export const permissionLevels = ['no_access', 'read', 'read_write'] as const;
export const PermissionLevelSchema = z.enum(permissionLevels);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const invitationStatuses = ['pending', 'accepted', 'revoked'] as const;
export const InvitationStatusSchema = z.enum(invitationStatuses);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

export const userRoles = ['player', 'admin'] as const;
export const UserRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const adminStatement = {
  player: ['view', 'update', 'ban'] as const,
  transaction: ['view', 'refund'] as const,
  game: ['view', 'enable', 'disable'] as const,
  content: ['create', 'update', 'delete', 'publish'] as const,
  'help-center': ['manage'] as const,
  compliance: ['view', 'override-limit', 'manage-rg', 'manage-geo'] as const,
  'regulatory-overview': ['view', 'manage-country-rules', 'manage-global-kyc'] as const,
  report: ['view'] as const,
  withdrawal: ['view', 'approve', 'reject', 'hold', 'auto-rule'] as const,
  bonus: ['view', 'create', 'update', 'pause', 'cancel'] as const,
  audit: ['view', 'export'] as const,
  admin: ['view', 'create', 'update', 'disable', 'delete'] as const,
  'game-config': ['view', 'create', 'update', 'delete', 'schedule'] as const,
  analytics: ['view'] as const,
  sportsbook: ['view', 'configure', 'suspend'] as const,
  affiliate: ['view', 'manage'] as const,
  sessions: ['view', 'revoke'] as const,
  'player-note': ['view', 'create'] as const,
  'tag-rule': ['view', 'update'] as const,
  tag: ['view', 'create', 'delete'] as const,
  'chat-room': ['view', 'create', 'update', 'delete'] as const,
  'auto-withdrawal-config': ['view', 'update'] as const,
  'wallet-asset': ['view', 'create', 'update', 'delete'] as const,
  'wallet-custody': ['view', 'run'] as const,
  'wallet-reconciliation': ['view', 'resolve', 'run'] as const,
  'swap-config': ['view', 'update'] as const,
  turnover: ['view', 'clear'] as const,
  'turnover-config': ['view', 'update'] as const,
  'kyc-override-request': ['request'] as const,
  'kyc-override-approval': ['view', 'approve'] as const,
  'bonus-grant-request': ['request'] as const,
  'bonus-grant-approval': ['view', 'approve'] as const,
  'treasury-rebalance-request': ['request'] as const,
  'treasury-rebalance-approval': ['view', 'approve'] as const,
  'chat-command': ['view', 'update'] as const,
  'chat-moderation': ['view', 'moderate'] as const,
  agent: ['view', 'create', 'update', 'publish', 'run'] as const,
  'agent-proposal': ['view', 'approve', 'reject'] as const,
  'agent-config': ['view', 'update'] as const,
  'mcp-access': ['use'] as const,
  'agent-chat': ['use'] as const,
  'mcp-token': ['view', 'revoke'] as const,
  'support-chat': ['view'] as const,
} as const;

export type AdminResource = keyof typeof adminStatement;
export type AdminActionOf<R extends AdminResource> = (typeof adminStatement)[R][number];

export const MCP_TOKEN_REVOKE_REASONS = [
  'manual',
  'admin_disabled',
  'admin_role_removed',
  'sessions_revoked',
  'revoked_all',
] as const;
export const McpTokenRevokeReasonSchema = z.enum(MCP_TOKEN_REVOKE_REASONS);
export type McpTokenRevokeReason = z.infer<typeof McpTokenRevokeReasonSchema>;
