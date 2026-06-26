import { statement, type ResourceName, type PermissionLevel } from '@blurifycom/core/server';

// Canonical spec of the predefined backoffice roles, consumed by seedRoles.
// Omitted matrix cells default to no_access.
type ModuleKey = ResourceName;

export type DefaultAdminRole = {
  key: string;
  name: string;
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
    isSuperAdmin: true,
    isSystem: true,
    matrix: allReadWrite,
  },
  {
    key: 'admin',
    name: 'Admin',
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
