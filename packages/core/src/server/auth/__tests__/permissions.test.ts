import { describe, expect, it } from 'vitest';
import { holdsGrant, isRoleName } from '../permissions.js';

describe('holdsGrant', () => {
  it('a role name outside the static table holds nothing', () => {
    expect(holdsGrant({ role: 'ghost', grants: null }, 'player', 'view')).toBe(false);
    expect(
      holdsGrant(
        { role: 'ghost', grants: [{ resource: 'player', action: 'view' }] },
        'player',
        'view',
      ),
    ).toBe(false);
  });

  it('a user with database grants holds exactly those grants', () => {
    const user = { role: 'support', grants: [{ resource: 'game', action: 'enable' }] };
    expect(holdsGrant(user, 'game', 'enable')).toBe(true);
  });

  it('a user with database grants does not fall back to the static role table', () => {
    const user = { role: 'admin', grants: [{ resource: 'game', action: 'enable' }] };
    expect(holdsGrant(user, 'player', 'view')).toBe(false);
    expect(holdsGrant({ role: 'admin', grants: [] }, 'player', 'view')).toBe(false);
  });

  it('a user with no database assignment falls back to the static role of the user', () => {
    expect(holdsGrant({ role: 'support', grants: null }, 'player', 'view')).toBe(true);
    expect(holdsGrant({ role: 'support', grants: null }, 'player', 'ban')).toBe(false);
    expect(holdsGrant({ role: 'admin', grants: null }, 'player', 'ban')).toBe(true);
    expect(holdsGrant({ role: 'content-manager', grants: null }, 'content', 'publish')).toBe(true);
    expect(holdsGrant({ role: 'content-manager', grants: null }, 'player', 'view')).toBe(false);
  });

  it('a grant for another resource or action is not held', () => {
    const grants = [{ resource: 'player', action: 'view' }];
    expect(holdsGrant({ role: 'admin', grants }, 'transaction', 'view')).toBe(false);
    expect(holdsGrant({ role: 'admin', grants }, 'player', 'ban')).toBe(false);
    expect(holdsGrant({ role: 'admin', grants: null }, 'nope', 'view')).toBe(false);
    expect(holdsGrant({ role: 'admin', grants: null }, 'player', 'nope')).toBe(false);
  });
});

describe('isRoleName', () => {
  it('accepts the defined role names', () => {
    expect(isRoleName('admin')).toBe(true);
    expect(isRoleName('support')).toBe(true);
    expect(isRoleName('content-manager')).toBe(true);
  });

  it('rejects inherited object keys such as constructor', () => {
    expect(isRoleName('constructor')).toBe(false);
    expect(isRoleName('toString')).toBe(false);
    expect(isRoleName('__proto__')).toBe(false);
  });
});
