import { describe, it, expect } from 'vitest';
import {
  levelRank,
  isLevelSufficient,
  levelToActions,
  actionsToLevel,
  PERMISSION_LEVELS,
  type PermissionLevel,
} from '../permission-levels.js';
import { statement } from '../permissions.js';

describe('levelRank', () => {
  it('orders the levels from no_access up to read_write', () => {
    expect(PERMISSION_LEVELS.map(levelRank)).toEqual([0, 1, 2]);
  });

  it('ranks an unknown level below every real one so it can never satisfy a check', () => {
    expect(levelRank('owner' as PermissionLevel)).toBe(-1);
  });
});

describe('isLevelSufficient', () => {
  it.each([
    ['no_access', 'no_access', true],
    ['no_access', 'read', false],
    ['no_access', 'read_write', false],
    ['read', 'no_access', true],
    ['read', 'read', true],
    ['read', 'read_write', false],
    ['read_write', 'no_access', true],
    ['read_write', 'read', true],
    ['read_write', 'read_write', true],
  ] as const)('%s covering %s is %s', (have, required, expected) => {
    expect(isLevelSufficient(have, required)).toBe(expected);
  });

  it('refuses to escalate an unknown level', () => {
    expect(isLevelSufficient('owner' as PermissionLevel, 'read')).toBe(false);
  });
});

describe('levelToActions', () => {
  it('grants nothing at no_access, whatever the resource', () => {
    for (const resource of Object.keys(statement)) {
      expect(levelToActions(resource, 'no_access')).toEqual([]);
    }
  });

  it('grants every declared action at read_write', () => {
    for (const [resource, actions] of Object.entries(statement)) {
      expect(levelToActions(resource, 'read_write')).toEqual(actions);
    }
  });

  it('grants only view at read', () => {
    expect(levelToActions('player', 'read')).toEqual(['view']);
    expect(levelToActions('withdrawal', 'read')).toEqual(['view']);
  });

  it('grants nothing at read for a resource that declares no view action', () => {
    expect(statement.content).not.toContain('view');
    expect(levelToActions('content', 'read')).toEqual([]);
  });

  it.each(PERMISSION_LEVELS)('grants nothing on an unknown resource at %s', (level) => {
    expect(levelToActions('tournaments', level)).toEqual([]);
  });

  it('never returns an action the resource does not declare', () => {
    for (const [resource, actions] of Object.entries(statement)) {
      for (const level of PERMISSION_LEVELS) {
        expect(actions).toEqual(expect.arrayContaining([...levelToActions(resource, level)]));
      }
    }
  });
});

describe('actionsToLevel', () => {
  it('round-trips every level for every resource that can express it', () => {
    for (const [resource, actions] of Object.entries(statement)) {
      const viewOnlyResource = actions.length === 1 && actions[0] === 'view';
      for (const level of PERMISSION_LEVELS) {
        const granted = levelToActions(resource, level);
        const expected =
          granted.length === 0 ? 'no_access' : viewOnlyResource ? 'read_write' : level;
        expect(actionsToLevel(resource, granted)).toBe(expected);
      }
    }
  });

  it('cannot tell read from read_write on a resource whose only action is view', () => {
    expect(statement.report).toEqual(['view']);
    expect(actionsToLevel('report', ['view'])).toBe('read_write');
  });

  it('collapses a partial action set down, never up', () => {
    expect(actionsToLevel('player', ['view', 'update'])).toBe('read');
    expect(actionsToLevel('player', ['update', 'ban'])).toBe('no_access');
  });

  it('reports no_access for an unknown resource', () => {
    expect(actionsToLevel('tournaments', ['view'])).toBe('no_access');
  });

  it('reports no_access for an empty action set', () => {
    expect(actionsToLevel('player', [])).toBe('no_access');
  });

  it('ignores actions the resource does not declare', () => {
    expect(actionsToLevel('report', ['view', 'delete-everything'])).toBe('read_write');
  });
});
