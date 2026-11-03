import { describe, expect, it } from 'vitest';
import { levelToActions, roles, statement } from '@openora/core/server';
import { DEFAULT_ADMIN_ROLES } from '../seed/data/default-admin-roles.js';

const predefined = (key: string) => DEFAULT_ADMIN_ROLES.find((role) => role.key === key);

describe('DEFAULT_ADMIN_ROLES', () => {
  it('gives the predefined admin role read-write MCP access and token oversight', () => {
    expect(predefined('admin')?.matrix).toMatchObject({
      'mcp-access': 'read_write',
      'mcp-token': 'read_write',
    });
  });

  it.each(['mcp-access', 'mcp-token'] as const)(
    'grants the predefined admin role every %s action the static admin role holds',
    (resource) => {
      const level = predefined('admin')?.matrix[resource] ?? 'no_access';

      expect(levelToActions(resource, level)).toEqual(statement[resource]);
      expect(roles.admin.authorize({ [resource]: [...statement[resource]] }).success).toBe(true);
    },
  );

  it('keeps the super-admin role flagged and covering every resource', () => {
    const superAdmin = predefined('super-admin');

    expect(superAdmin).toMatchObject({ isSuperAdmin: true, isSystem: true });
    expect(Object.keys(superAdmin?.matrix ?? {})).toEqual(Object.keys(statement));
  });

  it('grants MCP access to no other predefined role', () => {
    const withMcpAccess = DEFAULT_ADMIN_ROLES.filter(
      (role) => !role.isSuperAdmin && role.matrix['mcp-access'] !== undefined,
    );

    expect(withMcpAccess.map((role) => role.key)).toEqual(['admin']);
  });

  it('holds every approval resource for the super admin alone', () => {
    const approvals = Object.keys(statement).filter((resource) => resource.endsWith('-approval'));

    expect(approvals).toEqual([
      'kyc-override-approval',
      'bonus-grant-approval',
      'treasury-rebalance-approval',
    ]);
    const holders = DEFAULT_ADMIN_ROLES.filter((role) =>
      approvals.some((resource) => role.matrix[resource as keyof typeof role.matrix] !== undefined),
    );

    expect(holders.map((role) => role.key)).toEqual(['super-admin']);
  });

  it.each([
    ['kyc-override-request', ['customer-support-agent', 'support-manager', 'compliance-manager']],
    ['bonus-grant-request', ['customer-support-agent', 'support-manager', 'vip-manager']],
    ['treasury-rebalance-request', ['payments-manager', 'finance-accounting']],
  ] as const)('lets only the intended roles request through %s', (resource, requesters) => {
    const holders = DEFAULT_ADMIN_ROLES.filter(
      (role) => !role.isSuperAdmin && role.matrix[resource] !== undefined,
    );

    expect(holders.map((role) => role.key).sort()).toEqual([...requesters].sort());
  });
});
