import { createAccessControl } from 'better-auth/plugins/access';

export const statement = {
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
  'wallet-asset': ['view', 'create', 'update', 'delete'] as const,
  'wallet-custody': ['view', 'run'] as const,
  'wallet-reconciliation': ['view', 'resolve', 'run'] as const,
  'chat-command': ['view', 'update'] as const,
  'chat-moderation': ['view', 'moderate'] as const,
} as const;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  player: ['view', 'update', 'ban'],
  transaction: ['view', 'refund'],
  game: ['view', 'enable', 'disable'],
  content: ['create', 'update', 'delete', 'publish'],
  compliance: ['view', 'override-limit', 'manage-rg'],
  report: ['view'],
  withdrawal: ['view', 'approve', 'reject', 'hold', 'auto-rule'],
  bonus: ['view', 'create', 'update', 'pause', 'cancel'],
  audit: ['view', 'export'],
  admin: ['view', 'create', 'update', 'disable', 'delete'],
  'game-config': ['view', 'update', 'schedule'],
  analytics: ['view'],
  sportsbook: ['view', 'configure', 'suspend'],
  affiliate: ['view', 'manage'],
  sessions: ['view', 'revoke'],
  'player-note': ['view', 'create'],
  'tag-rule': ['view', 'update'],
  tag: ['view', 'create', 'delete'],
  'chat-room': ['view', 'create', 'update', 'delete'],
  'auto-withdrawal-config': ['view', 'update'],
  'wallet-asset': ['view', 'create', 'update', 'delete'],
  'wallet-custody': ['view', 'run'],
  'wallet-reconciliation': ['view', 'resolve', 'run'],
  'chat-command': ['view', 'update'],
  'chat-moderation': ['view', 'moderate'],
});

export const supportRole = ac.newRole({
  player: ['view', 'update'],
  transaction: ['view'],
  compliance: ['view'],
  report: ['view'],
  analytics: ['view'],
});

export const contentManagerRole = ac.newRole({
  content: ['create', 'update', 'delete', 'publish'],
  game: ['view', 'enable', 'disable'],
});

export const roles = {
  admin: adminRole,
  support: supportRole,
  'content-manager': contentManagerRole,
} as const;

export type RoleName = keyof typeof roles;
export type ResourceName = keyof typeof statement;
export type ActionOf<R extends ResourceName> = (typeof statement)[R][number];
