import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_LEVELS,
  actionsToLevel,
  isLevelSufficient,
  levelRank,
  levelToActions,
} from '../permission-levels.js';
import { statement } from '../permissions.js';

const resources = Object.keys(statement);
const resourceArb = fc.constantFrom(...resources);
const viewable = resources.filter((r) =>
  (statement[r as keyof typeof statement] as readonly string[]).includes('view'),
);

describe('levelRank', () => {
  it('orders no_access below read below read_write', () => {
    expect(PERMISSION_LEVELS.map(levelRank)).toEqual([0, 1, 2]);
  });
});

describe('isLevelSufficient', () => {
  it.each([
    ['read_write', 'read', true],
    ['read', 'read', true],
    ['read', 'read_write', false],
    ['no_access', 'read', false],
    ['no_access', 'no_access', true],
  ] as const)('have %s required %s is %s', (have, required, expected) => {
    expect(isLevelSufficient(have, required)).toBe(expected);
  });
});

describe('levelToActions', () => {
  it('gives every action of the resource at read_write', () => {
    expect(levelToActions('player', 'read_write')).toEqual(['view', 'update', 'ban']);
  });

  it('gives only view at read', () => {
    expect(levelToActions('player', 'read')).toEqual(['view']);
  });

  it('gives nothing at no_access', () => {
    expect(levelToActions('player', 'no_access')).toEqual([]);
  });

  it('gives nothing at read for a resource without a view action', () => {
    expect(levelToActions('content', 'read')).toEqual([]);
  });

  it.each(['read', 'read_write'] as const)(
    'gives nothing at %s for an unknown resource',
    (level) => {
      expect(levelToActions('nope', level)).toEqual([]);
    },
  );

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'gives nothing for the prototype key %s',
    (resource) => {
      expect(levelToActions(resource, 'read_write')).toEqual([]);
      expect(levelToActions(resource, 'read')).toEqual([]);
    },
  );

  it('never grants an action outside the resource catalog', () => {
    fc.assert(
      fc.property(resourceArb, fc.constantFrom(...PERMISSION_LEVELS), (resource, level) => {
        const catalog: readonly string[] = statement[resource as keyof typeof statement];
        expect(levelToActions(resource, level).every((a) => catalog.includes(a))).toBe(true);
      }),
    );
  });

  it('grows with the level', () => {
    fc.assert(
      fc.property(resourceArb, (resource) => {
        const [none, read, write] = PERMISSION_LEVELS.map((l) => levelToActions(resource, l));
        expect(none?.length).toBe(0);
        expect(read?.every((a) => write?.includes(a))).toBe(true);
      }),
    );
  });
});

describe('actionsToLevel', () => {
  it('maps the full action set to read_write', () => {
    expect(actionsToLevel('player', ['view', 'update', 'ban'])).toBe('read_write');
  });

  it('maps a view-only set to read', () => {
    expect(actionsToLevel('player', ['view'])).toBe('read');
  });

  it('maps a partial write set without view to no_access', () => {
    expect(actionsToLevel('player', ['update', 'ban'])).toBe('no_access');
  });

  it('maps view plus some writes to read', () => {
    expect(actionsToLevel('player', ['view', 'update'])).toBe('read');
  });

  it('maps an empty set to no_access', () => {
    expect(actionsToLevel('player', [])).toBe('no_access');
  });

  it('maps unknown actions to no_access', () => {
    expect(actionsToLevel('player', ['fly', 'teleport'])).toBe('no_access');
  });

  it.each(['nope', 'constructor', '__proto__'])(
    'maps unknown resource %s to no_access',
    (resource) => {
      expect(actionsToLevel(resource, ['view', 'update', 'ban'])).toBe('no_access');
    },
  );

  it('maps a partial action set on a resource without view to no_access', () => {
    expect(actionsToLevel('content', ['create', 'update'])).toBe('no_access');
  });
});

describe('level to actions to level', () => {
  it('round trips read_write for every resource', () => {
    fc.assert(
      fc.property(resourceArb, (resource) => {
        expect(actionsToLevel(resource, levelToActions(resource, 'read_write'))).toBe('read_write');
      }),
    );
  });

  it('round trips no_access for every resource', () => {
    fc.assert(
      fc.property(resourceArb, (resource) => {
        expect(actionsToLevel(resource, levelToActions(resource, 'no_access'))).toBe('no_access');
      }),
    );
  });

  it('round trips read for resources that have a view action and more actions', () => {
    const readable = viewable.filter(
      (r) => (statement[r as keyof typeof statement] as readonly string[]).length > 1,
    );
    fc.assert(
      fc.property(fc.constantFrom(...readable), (resource) => {
        expect(actionsToLevel(resource, levelToActions(resource, 'read'))).toBe('read');
      }),
    );
  });

  it('never widens the action set when a level is written and read back', () => {
    fc.assert(
      fc.property(resourceArb, fc.constantFrom(...PERMISSION_LEVELS), (resource, level) => {
        const written = levelToActions(resource, level);
        const back = levelToActions(resource, actionsToLevel(resource, written));
        expect([...back].sort()).toEqual([...written].sort());
      }),
    );
  });
});
