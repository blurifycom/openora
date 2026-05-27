import { createAccessControl } from 'better-auth/plugins/access';

export const statement = {
  player:      ['view', 'update', 'ban', 'adjust-balance'] as const,
  transaction: ['view', 'refund'] as const,
  game:        ['view', 'enable', 'disable'] as const,
  content:     ['create', 'update', 'delete', 'publish'] as const,
  compliance:  ['view', 'override-limit'] as const,
  report:      ['view'] as const,
} as const;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  player:      ['view', 'update', 'ban', 'adjust-balance'],
  transaction: ['view', 'refund'],
  game:        ['view', 'enable', 'disable'],
  content:     ['create', 'update', 'delete', 'publish'],
  compliance:  ['view', 'override-limit'],
  report:      ['view'],
});

export const supportRole = ac.newRole({
  player:      ['view', 'update'],
  transaction: ['view'],
  compliance:  ['view'],
  report:      ['view'],
});

export const contentManagerRole = ac.newRole({
  content: ['create', 'update', 'delete', 'publish'],
  game:    ['view', 'enable', 'disable'],
});

export const roles = {
  admin:             adminRole,
  support:           supportRole,
  'content-manager': contentManagerRole,
} as const;

export type RoleName = keyof typeof roles;
export type ResourceName = keyof typeof statement;
export type ActionOf<R extends ResourceName> = (typeof statement)[R][number];
