import { createAccessControl } from 'better-auth/plugins/access';
import { adminStatement, type AdminGrant } from '@openora/core/contracts';

export const statement = adminStatement;

export const ac = createAccessControl(statement);

const adminRole = ac.newRole({
  player: ['view', 'update', 'ban'],
  transaction: ['view', 'refund'],
  game: ['view', 'enable', 'disable'],
  content: ['create', 'update', 'delete', 'publish'],
  'help-center': ['manage'],
  compliance: ['view', 'override-limit', 'manage-rg', 'manage-geo'],
  report: ['view'],
  withdrawal: ['view', 'approve', 'reject', 'hold', 'auto-rule'],
  bonus: ['view', 'create', 'update', 'pause', 'cancel'],
  audit: ['view', 'export'],
  admin: ['view', 'create', 'update', 'disable', 'delete'],
  'game-config': ['view', 'create', 'update', 'delete', 'schedule'],
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
  'swap-config': ['view', 'update'],
  turnover: ['view', 'clear'],
  'turnover-config': ['view', 'update'],
  'kyc-override-request': ['request'],
  'kyc-override-approval': ['view', 'approve'],
  'bonus-grant-request': ['request'],
  'bonus-grant-approval': ['view', 'approve'],
  'treasury-rebalance-request': ['request'],
  'treasury-rebalance-approval': ['view', 'approve'],
  'chat-command': ['view', 'update'],
  'chat-moderation': ['view', 'moderate'],
  'regulatory-overview': ['view', 'manage-country-rules', 'manage-global-kyc'],
  agent: ['view', 'create', 'update', 'publish', 'run'],
  'agent-proposal': ['view', 'approve', 'reject'],
  'agent-config': ['view', 'update'],
  'mcp-access': ['use'],
  'agent-chat': ['use'],
  'mcp-token': ['view', 'revoke'],
});

const supportRole = ac.newRole({
  player: ['view', 'update'],
  transaction: ['view'],
  compliance: ['view'],
  report: ['view'],
  analytics: ['view'],
});

const contentManagerRole = ac.newRole({
  content: ['create', 'update', 'delete', 'publish'],
  game: ['view', 'enable', 'disable'],
});

export const roles = {
  admin: adminRole,
  support: supportRole,
  'content-manager': contentManagerRole,
} as const;

export type RoleName = keyof typeof roles;
export type {
  AdminResource as ResourceName,
  AdminActionOf as ActionOf,
} from '@openora/core/contracts';

export function isRoleName(name: string): name is RoleName {
  return Object.hasOwn(roles, name);
}

export function holdsGrant(
  { role, grants }: { role: string; grants: readonly AdminGrant[] | null },
  resource: string,
  action: string,
) {
  if (!isRoleName(role)) {
    return false;
  }
  if (grants !== null) {
    return grants.some((grant) => grant.resource === resource && grant.action === action);
  }
  return roles[role].authorize({ [resource]: [action] }).success;
}
