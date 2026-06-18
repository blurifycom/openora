import { createAccessControl } from 'better-auth/plugins/access';

export const statement = {
  player: ['view', 'update', 'ban', 'adjust-balance'] as const,
  transaction: ['view', 'refund'] as const,
  game: ['view', 'enable', 'disable'] as const,
  content: ['create', 'update', 'delete', 'publish'] as const,
  compliance: ['view', 'override-limit'] as const,
  report: ['view'] as const,
  withdrawal: ['view', 'approve', 'reject', 'hold'] as const,
  bonus: ['view', 'create', 'update', 'pause', 'cancel'] as const,
  audit: ['view', 'export'] as const,
  admin: ['view', 'create', 'update', 'disable', 'delete'] as const,
  'game-config': ['view', 'update', 'schedule'] as const,
  analytics: ['view'] as const,
  sportsbook: ['view', 'configure', 'suspend'] as const,
  affiliate: ['view', 'manage'] as const,
} as const;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  player: ['view', 'update', 'ban', 'adjust-balance'],
  transaction: ['view', 'refund'],
  game: ['view', 'enable', 'disable'],
  content: ['create', 'update', 'delete', 'publish'],
  compliance: ['view', 'override-limit'],
  report: ['view'],
  withdrawal: ['view', 'approve', 'reject', 'hold'],
  bonus: ['view', 'create', 'update', 'pause', 'cancel'],
  audit: ['view', 'export'],
  admin: ['view', 'create', 'update', 'disable', 'delete'],
  'game-config': ['view', 'update', 'schedule'],
  analytics: ['view'],
  sportsbook: ['view', 'configure', 'suspend'],
  affiliate: ['view', 'manage'],
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
