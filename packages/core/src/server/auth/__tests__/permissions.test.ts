import { describe, it, expect } from 'vitest';
import { adminStatement } from '@openora/core/contracts';
import { adminRole, statement } from '../permissions.js';

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
