import { describe, it, expect } from 'vitest';
import { adminStatement } from '@openora/core/contracts';
import { adminRole, holdsGrant, isRoleName, statement } from '../permissions.js';

describe('admin permission catalog', () => {
  it('serves the same catalog the browser imports from contracts', () => {
    expect(statement).toBe(adminStatement);
  });

  // The built-in `admin` role is the AdminGuard fallback when the iam module is
  // absent, and it mirrors the catalog by hand on purpose: a new resource must
  // be granted deliberately, not inherited. This catches the drift instead.
  it('grants the built-in admin role every action in the catalog', () => {
    expect(adminRole.statements).toEqual(adminStatement);
  });

  it('declares the agent resources and grants them to the built-in admin role', () => {
    expect(adminStatement).toMatchObject({
      agent: ['view', 'create', 'update', 'publish', 'run'],
      'agent-proposal': ['view', 'approve', 'reject'],
      'agent-config': ['view', 'update'],
    });
    expect(
      adminRole.authorize({
        agent: ['view', 'create', 'update', 'publish', 'run'],
        'agent-proposal': ['view', 'approve', 'reject'],
        'agent-config': ['view', 'update'],
      }).success,
    ).toBe(true);
  });
});

describe('isRoleName', () => {
  it.each(['admin', 'support', 'content-manager'])('knows the static %s role', (role) => {
    expect(isRoleName(role)).toBe(true);
  });

  it.each(['player', 'constructor', '__proto__', 'toString'])('does not know %s', (role) => {
    expect(isRoleName(role)).toBe(false);
  });
});

describe('holdsGrant', () => {
  it('decides from the DB grants alone when the user holds an assignment', () => {
    const grants = [{ resource: 'player', action: 'view' }];

    expect(holdsGrant({ role: 'admin', grants }, 'player', 'view')).toBe(true);
    expect(holdsGrant({ role: 'admin', grants }, 'mcp-access', 'use')).toBe(false);
    expect(holdsGrant({ role: 'support', grants: [] }, 'player', 'view')).toBe(false);
  });

  it('falls back to the static role table without an assignment', () => {
    expect(holdsGrant({ role: 'admin', grants: null }, 'mcp-access', 'use')).toBe(true);
    expect(holdsGrant({ role: 'support', grants: null }, 'player', 'view')).toBe(true);
    expect(holdsGrant({ role: 'support', grants: null }, 'mcp-access', 'use')).toBe(false);
  });

  it('holds nothing for a role the static table does not know, grants or not', () => {
    const grants = [{ resource: 'mcp-access', action: 'use' }];

    expect(holdsGrant({ role: 'player', grants }, 'mcp-access', 'use')).toBe(false);
    expect(holdsGrant({ role: 'constructor', grants: null }, 'mcp-access', 'use')).toBe(false);
  });
});
