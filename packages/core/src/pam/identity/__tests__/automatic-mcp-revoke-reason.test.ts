import { describe, expect, it } from 'vitest';
import { automaticMcpRevokeReason } from '../admin-user-directory.js';

const ACTIVE_ADMIN = { isActive: true, role: 'admin' };
const INACTIVE_ADMIN = { isActive: false, role: 'admin' };

describe('automaticMcpRevokeReason', () => {
  it('names a deactivation of an active account admin_disabled', () => {
    expect(automaticMcpRevokeReason(ACTIVE_ADMIN, { isActive: false })).toBe('admin_disabled');
  });

  it('prefers admin_disabled when one patch both deactivates and demotes', () => {
    expect(automaticMcpRevokeReason(ACTIVE_ADMIN, { isActive: false, role: 'player' })).toBe(
      'admin_disabled',
    );
  });

  it('names a demotion from admin admin_role_removed', () => {
    expect(automaticMcpRevokeReason(ACTIVE_ADMIN, { role: 'player' })).toBe('admin_role_removed');
    expect(automaticMcpRevokeReason(ACTIVE_ADMIN, { role: 'support' })).toBe('admin_role_removed');
  });

  it('names a demotion of an already inactive admin admin_role_removed', () => {
    expect(automaticMcpRevokeReason(INACTIVE_ADMIN, { role: 'player' })).toBe('admin_role_removed');
  });

  it.each([
    ['a reactivation', INACTIVE_ADMIN, { isActive: true }],
    ['an unchanged active flag and role', ACTIVE_ADMIN, { isActive: true, role: 'admin' }],
    ['a deactivation of an inactive account', INACTIVE_ADMIN, { isActive: false }],
    ['an empty patch', ACTIVE_ADMIN, {}],
    ['a promotion to admin', { isActive: true, role: 'player' }, { role: 'admin' }],
    ['a change between non-admin roles', { isActive: true, role: 'support' }, { role: 'player' }],
  ])('leaves the tokens alone on %s', (_case, existing, patch) => {
    expect(automaticMcpRevokeReason(existing, patch)).toBeNull();
  });
});
