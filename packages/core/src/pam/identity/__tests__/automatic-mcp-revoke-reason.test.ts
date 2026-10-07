import { describe, expect, it } from 'vitest';
import { automaticMcpRevokeReason } from '../admin-user-directory.js';

describe('automaticMcpRevokeReason', () => {
  it('names a patch that writes an inactive account admin_disabled', () => {
    expect(automaticMcpRevokeReason({ isActive: false })).toBe('admin_disabled');
  });

  it('prefers admin_disabled when one patch both deactivates and demotes', () => {
    expect(automaticMcpRevokeReason({ isActive: false, role: 'player' })).toBe('admin_disabled');
  });

  it.each(['player', 'support', 'content-manager'])(
    'names a patch that writes the %s role admin_role_removed',
    (role) => {
      expect(automaticMcpRevokeReason({ role })).toBe('admin_role_removed');
    },
  );

  it('names a demotion that also reactivates admin_role_removed', () => {
    expect(automaticMcpRevokeReason({ isActive: true, role: 'player' })).toBe('admin_role_removed');
  });

  it.each([
    ['a reactivation', { isActive: true }],
    ['a write of the admin role', { role: 'admin' }],
    ['an active admin written as such', { isActive: true, role: 'admin' }],
    ['an empty patch', {}],
  ])('leaves the tokens alone on %s', (_case, patch) => {
    expect(automaticMcpRevokeReason(patch)).toBeNull();
  });
});
