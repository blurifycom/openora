import { describe, expect, it } from 'vitest';
import { adminStatement, permissionLevels } from '@openora/core/contracts';
import {
  actionsToLevel,
  isLevelSufficient,
  levelRank,
  levelToActions,
} from '../permission-levels.js';

const resources = Object.keys(adminStatement);
const withView = resources.filter((r) => levelToActions(r, 'read_write').includes('view'));
const withoutView = resources.filter((r) => !levelToActions(r, 'read_write').includes('view'));

describe('levelRank and isLevelSufficient', () => {
  it('ranks no_access below read below read_write', () => {
    expect(levelRank('no_access')).toBeLessThan(levelRank('read'));
    expect(levelRank('read')).toBeLessThan(levelRank('read_write'));
  });

  it('a level is sufficient for itself and any lower level', () => {
    for (const have of permissionLevels) {
      for (const required of permissionLevels) {
        if (levelRank(have) >= levelRank(required)) {
          expect(isLevelSufficient(have, required)).toBe(true);
        }
      }
    }
  });

  it('a lower level is not sufficient for a higher one', () => {
    expect(isLevelSufficient('no_access', 'read')).toBe(false);
    expect(isLevelSufficient('no_access', 'read_write')).toBe(false);
    expect(isLevelSufficient('read', 'read_write')).toBe(false);
  });
});

describe('levelToActions', () => {
  it('no_access yields no actions', () => {
    for (const resource of resources) {
      expect(levelToActions(resource, 'no_access')).toEqual([]);
    }
  });

  it('read_write yields every action of the resource', () => {
    expect(resources.length).toBeGreaterThan(0);
    for (const [resource, actions] of Object.entries(adminStatement)) {
      expect(levelToActions(resource, 'read_write')).toEqual(actions);
    }
  });

  it('read yields only view for a resource that has view', () => {
    expect(withView).toContain('player');
    for (const resource of withView) {
      expect(levelToActions(resource, 'read')).toEqual(['view']);
    }
  });

  it('read yields nothing for a resource without view', () => {
    expect(withoutView).toContain('content');
    for (const resource of withoutView) {
      expect(levelToActions(resource, 'read')).toEqual([]);
    }
  });

  it('an unknown resource yields no actions', () => {
    for (const level of permissionLevels) {
      expect(levelToActions('does-not-exist', level)).toEqual([]);
    }
  });
});

describe('actionsToLevel', () => {
  it('all actions collapse to read_write', () => {
    for (const resource of resources) {
      expect(actionsToLevel(resource, levelToActions(resource, 'read_write'))).toBe('read_write');
    }
  });

  it('only view collapses to read', () => {
    expect(actionsToLevel('player', ['view'])).toBe('read');
    expect(actionsToLevel('player', ['view', 'update'])).toBe('read');
  });

  it('a partial non view set collapses to no_access', () => {
    expect(actionsToLevel('player', ['update'])).toBe('no_access');
    expect(actionsToLevel('content', ['create', 'update'])).toBe('no_access');
  });

  it('an unknown resource or empty action list collapses to no_access', () => {
    expect(actionsToLevel('does-not-exist', ['view'])).toBe('no_access');
    expect(actionsToLevel('player', [])).toBe('no_access');
  });
});
