import { statement, type ResourceName } from './permissions.js';

// Caller can only grant a level <= their own per module (no-escalation invariant).
export type PermissionLevel = 'no_access' | 'read' | 'read_write';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['no_access', 'read', 'read_write'];

export const SUPPORTED_LEVELS: readonly PermissionLevel[] = PERMISSION_LEVELS;

export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function isLevelSufficient(have: PermissionLevel, required: PermissionLevel): boolean {
  return levelRank(have) >= levelRank(required);
}

// `content` has no 'view' action (create/update/delete/publish only), so read level
// maps to an empty set there - effectively read_write-or-nothing for that resource.
export const readActions: Partial<Record<ResourceName, readonly string[]>> = Object.fromEntries(
  (Object.keys(statement) as ResourceName[]).map((resource) => {
    const actions = statement[resource] as readonly string[];
    return [resource, actions.includes('view') ? ['view'] : []];
  }),
) as Partial<Record<ResourceName, readonly string[]>>;

/** Expands a (resource, level) cell to the action set AdminGuard checks - levels are stored, actions derived at the authz edge. */
export function levelToActions(resource: string, level: PermissionLevel): readonly string[] {
  const actions = statement[resource as ResourceName] as readonly string[] | undefined;
  if (!actions) return [];
  if (level === 'no_access') return [];
  if (level === 'read_write') return actions;
  return readActions[resource as ResourceName] ?? (actions.includes('view') ? ['view'] : []);
}

/** Collapses a concrete action set to the closest level - used only for legacy/edge data; new writes are level-native. */
export function actionsToLevel(resource: string, actions: readonly string[]): PermissionLevel {
  const all = statement[resource as ResourceName] as readonly string[] | undefined;
  if (!all || all.length === 0) return 'no_access';
  const has = new Set(actions);
  if (all.every((a) => has.has(a))) return 'read_write';
  const read = readActions[resource as ResourceName] ?? [];
  if (read.length > 0 && read.every((a) => has.has(a))) return 'read';
  return 'no_access';
}

// 15 predefined backoffice roles: seeded once per tenant by `ensureDefaultRoles`,
// never clobbered on later edits. Omitted matrix cells default to no_access.
export type ModuleKey = ResourceName;

export type DefaultAdminRole = {
  key: string;
  name: string;
  description: string;
  isSuperAdmin: boolean;
  isSystem: true;
  matrix: Partial<Record<ModuleKey, PermissionLevel>>;
};

const RW: PermissionLevel = 'read_write';
const R: PermissionLevel = 'read';

const allReadWrite: Partial<Record<ModuleKey, PermissionLevel>> = Object.fromEntries(
  (Object.keys(statement) as ModuleKey[]).map((m) => [m, RW]),
);

export const DEFAULT_ADMIN_ROLES: readonly DefaultAdminRole[] = [
  {
    key: 'super-admin',
    name: 'Super Admin',
    description: 'Unrestricted access to every module; can manage roles and admins.',
    isSuperAdmin: true,
    isSystem: true,
    matrix: allReadWrite,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Broad operational access without super-admin role/admin management.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: RW,
      transaction: R,
      game: R,
      content: RW,
      compliance: R,
      report: RW,
      withdrawal: R,
      bonus: R,
      audit: R,
      'game-config': R,
      analytics: RW,
      sportsbook: R,
      affiliate: R,
    },
  },
  {
    key: 'sportsbook-manager',
    name: 'Sportsbook Manager',
    description: 'Configures sportsbook offering and game catalog.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      game: R,
      report: R,
      bonus: R,
      'game-config': RW,
      analytics: RW,
      sportsbook: RW,
    },
  },
  {
    key: 'casino-manager',
    name: 'Casino Manager',
    description: 'Manages the casino game catalog and configuration.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      game: RW,
      report: R,
      bonus: R,
      'game-config': RW,
      analytics: RW,
    },
  },
  {
    key: 'payments-manager',
    name: 'Payments Manager',
    description: 'Owns deposits, withdrawals, and transaction operations.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: RW,
      compliance: R,
      report: RW,
      withdrawal: RW,
      audit: R,
      analytics: R,
    },
  },
  {
    key: 'risk-fraud-manager',
    name: 'Risk & Fraud Manager',
    description: 'Investigates players, manages compliance flags and withdrawals review.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: RW,
      transaction: R,
      compliance: RW,
      report: RW,
      withdrawal: R,
      audit: R,
      analytics: RW,
    },
  },
  {
    key: 'compliance-manager',
    name: 'Compliance Manager',
    description: 'Owns compliance, KYC/AML oversight, and the audit trail.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      compliance: RW,
      report: RW,
      withdrawal: R,
      audit: RW,
      analytics: R,
    },
  },
  {
    key: 'kyc-aml-officer',
    name: 'KYC/AML Officer',
    description: 'Reviews KYC documents and AML cases.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      compliance: RW,
      report: R,
      withdrawal: R,
      audit: R,
    },
  },
  {
    key: 'affiliate-manager',
    name: 'Affiliate Manager',
    description: 'Manages affiliate programs, banners, and reporting.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      content: R,
      report: RW,
      bonus: R,
      analytics: RW,
      affiliate: RW,
    },
  },
  {
    key: 'marketing-banners',
    name: 'Marketing (Banners)',
    description: 'Manages CMS banners and marketing content.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      content: RW,
      report: R,
      bonus: R,
      analytics: R,
    },
  },
  {
    key: 'bonus-promotions',
    name: 'Bonus & Promotions',
    description: 'Owns bonuses and promotional campaigns.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      content: R,
      report: R,
      bonus: RW,
      analytics: RW,
    },
  },
  {
    key: 'finance-accounting',
    name: 'Finance / Accounting',
    description: 'Financial reporting and transaction reconciliation.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: RW,
      compliance: R,
      report: RW,
      withdrawal: R,
      audit: R,
      analytics: R,
    },
  },
  {
    key: 'customer-support-agent',
    name: 'Customer Support Agent',
    description: 'Front-line support; read access to player and transaction data.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: R,
      transaction: R,
      compliance: R,
      withdrawal: R,
      bonus: R,
    },
  },
  {
    key: 'support-manager',
    name: 'Support Manager',
    description: 'Supervises support; can act on player accounts and reports.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: RW,
      transaction: R,
      content: R,
      compliance: R,
      report: RW,
      withdrawal: R,
      bonus: R,
      audit: R,
      analytics: R,
    },
  },
  {
    key: 'vip-manager',
    name: 'VIP Manager',
    description: 'Manages VIP players, their content, and bonuses.',
    isSuperAdmin: false,
    isSystem: true,
    matrix: {
      player: RW,
      transaction: R,
      content: R,
      report: R,
      bonus: RW,
      analytics: RW,
    },
  },
];
