import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { statement, type PermissionLevel } from '@openora/core/server';
import { grantsOf } from '../../shared/admin-grants.js';
import { InvalidGrantError, grantsToLevelMap, validateGrants } from '../iam.service.js';

const catalog: Record<string, readonly string[]> = statement;
const resources = Object.keys(catalog).filter((r) => r !== 'admin');

describe('validateGrants', () => {
  it('accepts an empty list', () => {
    expect(() => validateGrants([])).not.toThrow();
  });

  it.each(['no_access', 'read', 'read_write'])('accepts level %s on a known module', (level) => {
    expect(() => validateGrants([{ resource: 'player', level }])).not.toThrow();
  });

  it('accepts every assignable module at every level', () => {
    const grants = resources.flatMap((resource) =>
      ['no_access', 'read', 'read_write'].map((level) => ({ resource, level })),
    );
    expect(() => validateGrants(grants)).not.toThrow();
  });

  it.each(['admin'])('refuses the super-admin-only module %s at any level', (resource) => {
    for (const level of ['no_access', 'read', 'read_write']) {
      expect(() => validateGrants([{ resource, level }])).toThrow(InvalidGrantError);
    }
  });

  it.each(['nope', '', 'Player', 'player '])('refuses unknown module %j', (resource) => {
    expect(() => validateGrants([{ resource, level: 'read' }])).toThrow(InvalidGrantError);
    expect(() => validateGrants([{ resource, level: 'read' }])).toThrow('Unknown module or level');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'refuses the prototype key %s as a module',
    (resource) => {
      expect(() => validateGrants([{ resource, level: 'read_write' }])).toThrow(InvalidGrantError);
    },
  );

  it.each(['', 'write', 'READ', 'read_write ', 'admin', 'constructor', '__proto__'])(
    'refuses unknown level %j',
    (level) => {
      expect(() => validateGrants([{ resource: 'player', level }])).toThrow(InvalidGrantError);
    },
  );

  it('refuses the list when one entry is bad', () => {
    expect(() =>
      validateGrants([
        { resource: 'player', level: 'read' },
        { resource: 'admin', level: 'read_write' },
      ]),
    ).toThrow(InvalidGrantError);
  });
});

describe('grantsToLevelMap', () => {
  it('maps an empty grant list to an empty map', () => {
    expect(grantsToLevelMap([])).toEqual({});
  });

  it('maps every action to read_write', () => {
    const grants = (catalog.player ?? []).map((action) => ({ resource: 'player', action }));
    expect(grantsToLevelMap(grants)).toEqual({ player: 'read_write' });
  });

  it('maps view alone to read', () => {
    expect(grantsToLevelMap([{ resource: 'player', action: 'view' }])).toEqual({ player: 'read' });
  });

  it('maps a write without view to no_access', () => {
    expect(grantsToLevelMap([{ resource: 'player', action: 'ban' }])).toEqual({
      player: 'no_access',
    });
  });

  it('maps a resource with a missing action to read when view is held', () => {
    expect(
      grantsToLevelMap([
        { resource: 'player', action: 'view' },
        { resource: 'player', action: 'update' },
      ]),
    ).toEqual({ player: 'read' });
  });

  it('maps a partial set on a resource without view to no_access', () => {
    expect(grantsToLevelMap([{ resource: 'content', action: 'create' }])).toEqual({
      content: 'no_access',
    });
  });

  it('ignores duplicate grants', () => {
    const grant = { resource: 'player', action: 'view' };
    expect(grantsToLevelMap([grant, grant, grant])).toEqual({ player: 'read' });
  });

  it('ignores unknown resources', () => {
    expect(grantsToLevelMap([{ resource: 'nope', action: 'view' }])).toEqual({});
  });

  it.each(['constructor', '__proto__', 'toString'])('ignores the prototype key %s', (resource) => {
    expect(grantsToLevelMap([{ resource, action: 'view' }])).toEqual({});
  });

  it('keeps resources apart', () => {
    expect(
      grantsToLevelMap([
        { resource: 'player', action: 'view' },
        { resource: 'transaction', action: 'view' },
        { resource: 'transaction', action: 'refund' },
      ]),
    ).toEqual({ player: 'read', transaction: 'read_write' });
  });

  it('does not depend on grant order', () => {
    const grants = resources.flatMap((resource) =>
      (catalog[resource] ?? []).map((action) => ({ resource, action })),
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(grants), (subset) => {
        expect(grantsToLevelMap([...subset].reverse())).toEqual(grantsToLevelMap(subset));
      }),
    );
  });
});

describe('grantsOf', () => {
  const levels = ['no_access', 'read', 'read_write'] as const satisfies readonly PermissionLevel[];

  it('gives every catalog action to a super admin', () => {
    const grants = grantsOf([{ isSuperAdmin: true, resource: null, level: null }]);
    const expected = Object.entries(catalog).flatMap(([resource, actions]) =>
      actions.map((action) => ({ resource, action })),
    );
    expect(grants).toEqual(expected);
  });

  it('gives a super admin everything even next to a restricted role', () => {
    const grants = grantsOf([
      { isSuperAdmin: false, resource: 'player', level: 'read' },
      { isSuperAdmin: true, resource: null, level: null },
    ]);
    expect(grants.length).toBeGreaterThan(1);
    expect(grants).toContainEqual({ resource: 'admin', action: 'delete' });
  });

  it('gives nothing for a role with no permission rows', () => {
    expect(grantsOf([{ isSuperAdmin: false, resource: null, level: null }])).toEqual([]);
  });

  it('gives nothing for no rows', () => {
    expect(grantsOf([])).toEqual([]);
  });

  it('expands read to view and read_write to all actions', () => {
    expect(
      grantsOf([
        { isSuperAdmin: false, resource: 'player', level: 'read' },
        { isSuperAdmin: false, resource: 'transaction', level: 'read_write' },
      ]),
    ).toEqual([
      { resource: 'player', action: 'view' },
      { resource: 'transaction', action: 'view' },
      { resource: 'transaction', action: 'refund' },
    ]);
  });

  it('gives nothing for no_access', () => {
    expect(grantsOf([{ isSuperAdmin: false, resource: 'player', level: 'no_access' }])).toEqual([]);
  });

  it('skips a row with a null resource or level', () => {
    expect(
      grantsOf([
        { isSuperAdmin: false, resource: null, level: 'read_write' },
        { isSuperAdmin: false, resource: 'player', level: null },
      ]),
    ).toEqual([]);
  });

  it('merges the same resource from two roles without duplicates, keeping the wider level', () => {
    const grants = grantsOf([
      { isSuperAdmin: false, resource: 'player', level: 'read' },
      { isSuperAdmin: false, resource: 'player', level: 'read_write' },
    ]);
    expect(grants).toEqual([
      { resource: 'player', action: 'view' },
      { resource: 'player', action: 'update' },
      { resource: 'player', action: 'ban' },
    ]);
  });

  it('gives nothing for an unknown resource', () => {
    expect(grantsOf([{ isSuperAdmin: false, resource: 'nope', level: 'read_write' }])).toEqual([]);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'gives nothing for the prototype key %s',
    (resource) => {
      expect(grantsOf([{ isSuperAdmin: false, resource, level: 'read_write' }])).toEqual([]);
    },
  );

  it('never lists a grant twice and does not depend on row order', () => {
    const rowArb = fc.record({
      isSuperAdmin: fc.constant(false),
      resource: fc.constantFrom(...resources),
      level: fc.constantFrom(...levels),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), (rows) => {
        const grants = grantsOf(rows);
        const keys = grants.map((g) => `${g.resource}:${g.action}`);
        expect(new Set(keys).size).toBe(keys.length);
        const reversed = grantsOf([...rows].reverse()).map((g) => `${g.resource}:${g.action}`);
        expect([...reversed].sort()).toEqual([...keys].sort());
      }),
    );
  });

  it('round trips through grantsToLevelMap for the highest level per resource', () => {
    const rowArb = fc.record({
      isSuperAdmin: fc.constant(false),
      resource: fc.constantFrom('player', 'transaction', 'game'),
      level: fc.constantFrom('read', 'read_write'),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 6 }), (rows) => {
        const map = grantsToLevelMap(grantsOf(rows));
        for (const row of rows) {
          const level = map[row.resource];
          expect(level === 'read' || level === 'read_write').toBe(true);
        }
      }),
    );
  });
});
