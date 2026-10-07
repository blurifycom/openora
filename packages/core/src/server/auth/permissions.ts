import { createAccessControl } from 'better-auth/plugins/access';
import { adminStatement, type AdminGrant } from '@openora/core/contracts';

// The catalog itself lives in contracts so the browser can import it too; this
// name stays because better-auth calls it a statement.
export const statement = adminStatement;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  player: ['view', 'update', 'ban'],
  transaction: ['view', 'refund'],
  game: ['view', 'enable', 'disable'],
  content: ['create', 'update', 'delete', 'publish'],
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
  'chat-command': ['view', 'update'],
  'chat-moderation': ['view', 'moderate'],
  'regulatory-overview': ['view', 'manage-country-rules', 'manage-global-kyc'],
  agent: ['view', 'create', 'update', 'publish', 'run'],
  'agent-proposal': ['view', 'approve', 'reject'],
  'agent-config': ['view', 'update'],
  'mcp-access': ['use'],
  'mcp-token': ['view', 'revoke'],
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
// Server-side aliases of the contract types, so AdminGuard.assert and the
// permission-level helpers keep reading in `server/auth` terms.
export type {
  AdminResource as ResourceName,
  AdminActionOf as ActionOf,
} from '@openora/core/contracts';

export function isRoleName(name: string): name is RoleName {
  return Object.hasOwn(roles, name);
}

/**
 * AdminGuard's grant rule. A user holding any DB role assignment has exactly the grants those
 * roles give (`grants`); a user with none (`null`) falls back to the static role table by
 * `user.role`. A role missing from that table holds nothing either way.
 */
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
