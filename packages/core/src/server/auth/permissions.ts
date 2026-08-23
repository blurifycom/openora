import { createAccessControl } from 'better-auth/plugins/access';
import { adminStatement } from '@openora/core/contracts';

// The catalog itself lives in contracts so the browser can import it too; this
// name stays because better-auth calls it a statement.
export const statement = adminStatement;

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
// Server-side aliases of the contract types, so AdminGuard.assert and the
// permission-level helpers keep reading in `server/auth` terms.
export type {
  AdminResource as ResourceName,
  AdminActionOf as ActionOf,
} from '@openora/core/contracts';
