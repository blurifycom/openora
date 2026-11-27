import { describe, expect, it } from 'vitest';
import { holdsGrant, isRoleName } from '../permissions.js';

describe('isRoleName', () => {
  it.each(['admin', 'support', 'content-manager'])('accepts %s', (name) => {
    expect(isRoleName(name)).toBe(true);
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'prototype',
    'Admin',
    'ADMIN',
    ' admin',
    'admin ',
    '',
    'player',
  ])('rejects %j', (name) => {
    expect(isRoleName(name)).toBe(false);
  });
});

describe('holdsGrant with DB grants', () => {
  const grants = [{ resource: 'player', action: 'view' }] as const;

  it('holds exactly the listed grant', () => {
    expect(holdsGrant({ role: 'support', grants }, 'player', 'view')).toBe(true);
  });

  it('refuses an action the DB roles do not list even when the static role has it', () => {
    expect(holdsGrant({ role: 'admin', grants }, 'player', 'ban')).toBe(false);
  });

  it('grants what the DB lists even when the static role lacks it', () => {
    expect(
      holdsGrant(
        { role: 'support', grants: [{ resource: 'player', action: 'ban' }] },
        'player',
        'ban',
      ),
    ).toBe(true);
  });

  it('refuses everything for an empty grant list', () => {
    expect(holdsGrant({ role: 'admin', grants: [] }, 'player', 'view')).toBe(false);
  });

  it('does not mix up resource and action', () => {
    expect(holdsGrant({ role: 'admin', grants }, 'view', 'player')).toBe(false);
  });
});

describe('holdsGrant falling back to the static role table', () => {
  it.each([
    ['admin', 'player', 'ban', true],
    ['admin', 'audit', 'export', true],
    ['support', 'player', 'view', true],
    ['support', 'player', 'ban', false],
    ['support', 'transaction', 'refund', false],
    ['content-manager', 'content', 'publish', true],
    ['content-manager', 'player', 'view', false],
    ['admin', 'nope', 'view', false],
    ['admin', 'player', 'nope', false],
  ] as const)('role %s on %s:%s is %s', (role, resource, action, expected) => {
    expect(holdsGrant({ role, grants: null }, resource, action)).toBe(expected);
  });
});

describe('holdsGrant with an unknown role', () => {
  it.each(['player', 'constructor', '__proto__', ''])('holds nothing as %j', (role) => {
    expect(holdsGrant({ role, grants: null }, 'player', 'view')).toBe(false);
    expect(
      holdsGrant({ role, grants: [{ resource: 'player', action: 'view' }] }, 'player', 'view'),
    ).toBe(false);
  });
});
