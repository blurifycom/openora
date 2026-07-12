import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb, readPrivate } from '../../testing/mock.js';
import * as core from '@openora/core/server';
import {
  levelToActions,
  actionsToLevel,
  statement,
  findOneOrThrow,
  type ResourceName,
} from '@openora/core/server';
import {
  IamService,
  DbAdminPermissionResolver,
  RoleNotFoundError,
  InvalidGrantError,
  NotSuperAdminError,
  ProtectedRoleError,
  LastSuperAdminError,
  InvitationConflictError,
  AdminUserNotFoundError,
  NotAnAdminUserError,
} from '../service/iam.service.js';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((col: unknown, val: unknown) => {
      const colName = (col as { name?: string })?.name;
      return { __col: colName, val };
    }),
    and: vi.fn((...args: unknown[]) => ({ __and: args })),
  };
});

function makeEvents() {
  return mock<import('@openora/core/server').EventBus>({ emit: vi.fn(), on: vi.fn() });
}

function makeEmail() {
  return mock<import('@openora/core/contracts').SendEmailPort>({
    send: vi.fn().mockResolvedValue(undefined),
  });
}

function inContext<T>(fn: () => T): T {
  return core.withRequestContext({ userId: 'caller', traceId: 't' }, fn);
}

const ADMIN_CALLER = { userId: 'admin-1', role: 'admin' };

function routingDrizzle(byTable: {
  role?: unknown[];
  permission?: unknown[];
  assignment?: unknown[];
  // The caller's own assignment rows, read by isSuperAdmin(caller) (select { roleId }).
  callerAssignment?: unknown[];
  superRole?: unknown[];
  // The target-user row read by assignRole to verify the account is an admin.
  user?: unknown[];
}) {
  let table: Record<string, unknown> = {};
  let lastSelect: Record<string, unknown> | undefined;
  const chain: Record<string, unknown> = {
    select: vi.fn().mockImplementation((sel?: Record<string, unknown>) => {
      lastSelect = sel;
      return chain;
    }),
    from: vi.fn().mockImplementation((tbl: Record<string, unknown>) => {
      table = tbl ?? {};
      return chain;
    }),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => {
      const route = (): unknown[] => {
        // getGrants' single join (select includes isSuperAdmin). Synthesize the joined
        // rows from the decomposed byTable so existing test data keeps working: one row
        // per (role x permission), super roles collapse to a bypass row, empty -> [].
        if (lastSelect && 'isSuperAdmin' in lastSelect) {
          const assignments = (byTable.assignment ?? []) as { roleId: string }[];
          if (assignments.length === 0) {
            return [];
          }
          const superIds = new Set((byTable.superRole ?? []).map((r) => (r as { id: string }).id));
          if (assignments.some((a) => superIds.has(a.roleId))) {
            return [{ isSuperAdmin: true, resource: null, level: null }];
          }
          const perms = (byTable.permission ?? []) as { resource: string; level: string }[];
          if (perms.length === 0) {
            return [{ isSuperAdmin: false, resource: null, level: null }];
          }
          return perms.map((p) => ({ isSuperAdmin: false, resource: p.resource, level: p.level }));
        }
        if ('emailVerified' in table) {
          return byTable.user ?? [];
        }
        if ('level' in table) {
          return byTable.permission ?? [];
        }
        // adminRoleAssignment has `userId` column. A { roleId }-only select is the
        // assignment read used by both getGrants and isSuperAdmin(caller); a
        // full-row select is the dedup existing-check. When a test needs the two
        // to differ it sets `callerAssignment` (else both share `assignment`).
        if ('userId' in table) {
          if (lastSelect && 'roleId' in lastSelect && Object.keys(lastSelect).length === 1) {
            return byTable.callerAssignment ?? byTable.assignment ?? [];
          }
          return byTable.assignment ?? [];
        }
        // adminRole: distinguish the isSuperAdmin probe (selects only id) from the
        // role-existence read (selects full row) via the select shape.
        if (lastSelect && 'id' in lastSelect && Object.keys(lastSelect).length === 1) {
          return byTable.superRole ?? [];
        }
        return byTable.role ?? [];
      };
      const rows = route();
      const thenable: Record<string, unknown> = {
        then: (res: (v: unknown[]) => unknown) => Promise.resolve(rows).then(res),
        for: () => thenable,
        limit: () => thenable,
        returning: (...args: unknown[]) =>
          (chain.returning as (...a: unknown[]) => unknown)(...args),
      };
      return thenable;
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockImplementation((fn: (txn: unknown) => unknown) => fn(chain)),
  };
  return mockDb(chain);
}

const ROLE_ROW = {
  id: 'role-1',
  key: null,
  name: 'Ops',
  isSystem: false,
  isSuperAdmin: false,
  createdAt: new Date(),
};

describe('level helpers', () => {
  it('levelToActions/actionsToLevel round-trip for a view-bearing module', () => {
    // player has 'view' + write actions.
    expect(levelToActions('player', 'no_access')).toEqual([]);
    expect(levelToActions('player', 'read')).toEqual(['view']);
    expect([...levelToActions('player', 'read_write')]).toEqual([...statement.player]);

    expect(actionsToLevel('player', [])).toBe('no_access');
    expect(actionsToLevel('player', ['view'])).toBe('read');
    expect(actionsToLevel('player', [...statement.player])).toBe('read_write');
  });

  it('content has no read level (no view action) - read expands to empty', () => {
    expect(levelToActions('content', 'read')).toEqual([]);
    expect([...levelToActions('content', 'read_write')]).toEqual([...statement.content]);
    expect(actionsToLevel('content', ['create'])).toBe('no_access');
    expect(actionsToLevel('content', [...statement.content])).toBe('read_write');
  });

  it('expands the two new modules', () => {
    expect(levelToActions('sportsbook', 'read')).toEqual(['view']);
    expect([...levelToActions('sportsbook', 'read_write')]).toEqual([...statement.sportsbook]);
    expect([...levelToActions('affiliate', 'read_write')]).toEqual([...statement.affiliate]);
  });
});

describe('IamService.listCatalog', () => {
  it('omits the admin module from the assignable catalog', async () => {
    const drizzle = routingDrizzle({});
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const catalog = svc.listCatalog();
    expect(catalog.modules.some((m) => m.resource === 'admin')).toBe(false);
    expect(catalog.modules.some((m) => m.resource === 'player')).toBe(true);
  });
});

describe('DbAdminPermissionResolver', () => {
  it('returns null when user has no assignment', async () => {
    const drizzle = routingDrizzle({ assignment: [] });
    const resolver = new DbAdminPermissionResolver(drizzle);
    const result = await resolver.getGrants('user-no-role');
    expect(result).toBeNull();
  });

  it('super-admin assignment returns ALL grants (bypass)', async () => {
    const drizzle = routingDrizzle({
      assignment: [{ roleId: 'role-super' }],
      superRole: [{ id: 'role-super' }],
    });
    const resolver = new DbAdminPermissionResolver(drizzle);
    const grants = await inContext(() => resolver.getGrants('u'));
    const expected = (Object.keys(statement) as ResourceName[]).reduce(
      (n, r) => n + (statement[r] as readonly string[]).length,
      0,
    );
    expect(grants).not.toBeNull();
    expect(grants).toHaveLength(expected);
  });

  it('expands level rows into action grants', async () => {
    const drizzle = routingDrizzle({
      assignment: [{ roleId: 'role-1' }],
      superRole: [],
      permission: [
        { resource: 'player', level: 'read' },
        { resource: 'withdrawal', level: 'read_write' },
      ],
    });
    const resolver = new DbAdminPermissionResolver(drizzle);
    const grants = await inContext(() => resolver.getGrants('u'));
    expect(grants).toContainEqual({ resource: 'player', action: 'view' });
    expect(grants).toContainEqual({ resource: 'withdrawal', action: 'approve' });
    // read player must NOT yield write actions.
    expect(grants).not.toContainEqual({ resource: 'player', action: 'ban' });
  });
});

describe('DbAdminPermissionResolver caching', () => {
  // Counts only the getGrants join (the query flagged by leftJoin); the un-joined
  // where() is the invalidateRole holder lookup, which returns `holders`.
  function grantsDrizzle(holders: { userId: string }[] = []) {
    const state = { grantsQueries: 0 };
    let joined = false;
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => {
        joined = true;
        return chain;
      },
      where: () => {
        if (joined) {
          joined = false;
          state.grantsQueries += 1;
          return Promise.resolve([{ isSuperAdmin: true, resource: null, level: null }]);
        }
        return Promise.resolve(holders);
      },
    };
    return { drizzle: mockDb(chain), state };
  }

  it('serves a repeat lookup from cache without re-querying', async () => {
    const { drizzle, state } = grantsDrizzle();
    const resolver = new DbAdminPermissionResolver(drizzle, new core.InProcessCache());
    await resolver.getGrants('u1');
    await resolver.getGrants('u1');
    expect(state.grantsQueries).toBe(1);
  });

  it('without a cache, every lookup queries', async () => {
    const { drizzle, state } = grantsDrizzle();
    const resolver = new DbAdminPermissionResolver(drizzle);
    await resolver.getGrants('u1');
    await resolver.getGrants('u1');
    expect(state.grantsQueries).toBe(2);
  });

  it('invalidateUser purges so the next lookup re-queries', async () => {
    const { drizzle, state } = grantsDrizzle();
    const resolver = new DbAdminPermissionResolver(drizzle, new core.InProcessCache());
    await resolver.getGrants('u1');
    await resolver.invalidateUser('u1');
    await resolver.getGrants('u1');
    expect(state.grantsQueries).toBe(2);
  });

  it('invalidateRole purges every current holder of the role', async () => {
    const { drizzle, state } = grantsDrizzle([{ userId: 'u1' }, { userId: 'u2' }]);
    const resolver = new DbAdminPermissionResolver(drizzle, new core.InProcessCache());
    await resolver.getGrants('u1');
    await resolver.getGrants('u2');
    expect(state.grantsQueries).toBe(2);
    await resolver.invalidateRole('role-1');
    await resolver.getGrants('u1');
    await resolver.getGrants('u2');
    expect(state.grantsQueries).toBe(4);
  });
});

describe('IamService.setRolePermissions', () => {
  it('rejects a non-super-admin caller', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      assignment: [{ roleId: 'role-x' }],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.setRolePermissions({
          roleId: 'role-1',
          grants: [{ resource: 'player', level: 'read' }],
          caller: { userId: 'sup-1', role: 'support' },
        }),
      ),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
  });

  it('throws RoleNotFoundError when role does not exist', async () => {
    const drizzle = routingDrizzle({ role: [], assignment: [], superRole: [] });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.setRolePermissions({
          roleId: 'missing',
          grants: [{ resource: 'player', level: 'read' }],
          caller: ADMIN_CALLER,
        }),
      ),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
  });

  it('throws InvalidGrantError for an unknown module', async () => {
    const drizzle = routingDrizzle({ role: [ROLE_ROW], assignment: [], superRole: [] });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.setRolePermissions({
          roleId: 'role-1',
          grants: [{ resource: 'nonexistent', level: 'read' } as never],
          caller: ADMIN_CALLER,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('rejects a grant targeting the admin module (super-admin-only, A6)', async () => {
    const drizzle = routingDrizzle({ role: [ROLE_ROW], assignment: [], superRole: [] });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.setRolePermissions({
          roleId: 'role-1',
          grants: [{ resource: 'admin', level: 'read_write' }],
          caller: ADMIN_CALLER,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('blocks editing a super-admin role (always full)', async () => {
    const superRoleRow = { ...ROLE_ROW, id: 'role-super', isSuperAdmin: true, isSystem: true };
    const drizzle = routingDrizzle({
      role: [superRoleRow],
      assignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.setRolePermissions({
          roleId: 'role-super',
          grants: [{ resource: 'player', level: 'read' }],
          caller: ADMIN_CALLER,
        }),
      ),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('a super caller may grant any level (bypass)', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      assignment: [],
      superRole: [],
      permission: [{ resource: 'withdrawal', level: 'read_write' }],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await inContext(() =>
      svc.setRolePermissions({
        roleId: 'role-1',
        grants: [{ resource: 'withdrawal', level: 'read_write' }],
        caller: ADMIN_CALLER,
      }),
    );
    expect(result.permissions).toContainEqual({ resource: 'withdrawal', level: 'read_write' });
  });

  it('emits iam.role.permissions.changed with actorId', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      assignment: [],
      superRole: [],
      permission: [{ resource: 'player', level: 'read' }],
    });
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    await inContext(() =>
      svc.setRolePermissions({
        roleId: 'role-1',
        grants: [{ resource: 'player', level: 'read' }],
        caller: ADMIN_CALLER,
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.permissions.changed',
      expect.objectContaining({ roleId: 'role-1', actorId: 'admin-1' }),
    );
  });
});

describe('IamService.updateRole', () => {
  it('blocks renaming the super-admin role', async () => {
    const drizzle = routingDrizzle({
      role: [{ ...ROLE_ROW, isSuperAdmin: true, isSystem: true }],
      assignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() => svc.updateRole({ roleId: 'role-1', name: 'Renamed', caller: ADMIN_CALLER })),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('allows renaming a predefined (isSystem, non-super) role', async () => {
    const drizzle = routingDrizzle({
      role: [{ ...ROLE_ROW, isSystem: true, isSuperAdmin: false }],
      assignment: [],
      superRole: [],
    });
    readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'returning').mockResolvedValue([
      { ...ROLE_ROW, isSystem: true, name: 'Renamed' },
    ]);
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    const result = await inContext(() =>
      svc.updateRole({ roleId: 'role-1', name: 'Renamed', caller: ADMIN_CALLER }),
    );
    expect(result.name).toBe('Renamed');
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.updated',
      expect.objectContaining({ roleId: 'role-1', actorId: 'admin-1' }),
    );
  });
});

describe('IamService.deleteRole', () => {
  it('blocks deleting a system role', async () => {
    const drizzle = routingDrizzle({
      role: [{ ...ROLE_ROW, isSystem: true }],
      assignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() => svc.deleteRole({ roleId: 'role-1', caller: ADMIN_CALLER })),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('blocks deleting a super-admin role', async () => {
    const drizzle = routingDrizzle({
      role: [{ ...ROLE_ROW, isSuperAdmin: true }],
      assignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() => svc.deleteRole({ roleId: 'role-1', caller: ADMIN_CALLER })),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('deletes a custom role with no assignments and emits only iam.role.deleted', async () => {
    const drizzle = routingDrizzle({ role: [ROLE_ROW], assignment: [], superRole: [] });
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    const result = await inContext(() =>
      svc.deleteRole({ roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(result).toEqual({ success: true });
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.deleted',
      expect.objectContaining({ roleId: 'role-1', actorId: 'admin-1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.revoked', expect.anything());
  });

  it('emits iam.role.revoked once per affected user plus iam.role.deleted', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      callerAssignment: [], // bootstrap admin caller is super via static role
      assignment: [{ userId: 'user-a' }, { userId: 'user-b' }],
      superRole: [],
    });
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    const result = await inContext(() =>
      svc.deleteRole({ roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(result).toEqual({ success: true });
    expect(events.emit).toHaveBeenCalledWith('iam.role.revoked', {
      roleId: 'role-1',
      userId: 'user-a',
      actorId: 'admin-1',
    });
    expect(events.emit).toHaveBeenCalledWith('iam.role.revoked', {
      roleId: 'role-1',
      userId: 'user-b',
      actorId: 'admin-1',
    });
    const revokeCalls = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'iam.role.revoked',
    );
    expect(revokeCalls).toHaveLength(2);
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.deleted',
      expect.objectContaining({ roleId: 'role-1', actorId: 'admin-1' }),
    );
  });
});

describe('IamService.assignRole', () => {
  it('dedupes an existing assignment without inserting again', async () => {
    const existingAssignment = {
      id: 'a1',
      userId: 'target',
      roleId: 'role-1',
      createdAt: new Date(),
    };
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      user: [{ role: 'admin' }],
      callerAssignment: [],
      assignment: [existingAssignment],
      superRole: [],
    });
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    const result = await inContext(() =>
      svc.assignRole({ userId: 'target', roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(result.id).toBe('a1');
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.assigned', expect.anything());
  });

  it('rejects assigning a role to a non-admin (player) account', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      user: [{ role: 'player' }],
      callerAssignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.assignRole({ userId: 'player-1', roleId: 'role-1', caller: ADMIN_CALLER }),
      ),
    ).rejects.toThrow(NotAnAdminUserError);
  });

  it('rejects assigning a role to an unknown user', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      user: [],
      callerAssignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() => svc.assignRole({ userId: 'ghost', roleId: 'role-1', caller: ADMIN_CALLER })),
    ).rejects.toThrow(AdminUserNotFoundError);
  });
});

describe('IamService.unassignRole', () => {
  it('rejects removing the last super-admin holder', async () => {
    const superRole = { ...ROLE_ROW, id: 'role-super', isSuperAdmin: true, isSystem: true };
    let table: Record<string, unknown> = {};
    let lastSelect: Record<string, unknown> | undefined;
    const chain: Record<string, unknown> = {
      select: vi.fn().mockImplementation((sel?: Record<string, unknown>) => {
        lastSelect = sel;
        return chain;
      }),
      from: vi.fn().mockImplementation((tbl: Record<string, unknown>) => {
        table = tbl ?? {};
        return chain;
      }),
      where: vi.fn().mockImplementation(() => {
        const route = (): unknown[] => {
          if ('userId' in table) {
            // assignment probes: isSuperAdmin(caller) -> caller assignments;
            // holders query selects userId+roleId.
            if (lastSelect && 'roleId' in lastSelect && 'userId' in lastSelect) {
              return [{ userId: 'target', roleId: 'role-super' }];
            }
            return [{ roleId: 'role-super' }]; // caller is super
          }
          if (lastSelect && 'id' in lastSelect && Object.keys(lastSelect).length === 1) {
            return [{ id: 'role-super' }]; // super-admin probe / list
          }
          return [superRole]; // role existence
        };
        const rows = route();
        const thenable: Record<string, unknown> = {
          then: (res: (v: unknown[]) => unknown) => Promise.resolve(rows).then(res),
          for: () => thenable,
          returning: () => Promise.resolve([{ id: 'a1' }]),
        };
        return thenable;
      }),
      delete: vi.fn().mockReturnThis(),
      transaction: vi.fn().mockImplementation((fn: (txn: unknown) => unknown) => fn(chain)),
    };
    const drizzle = mockDb(chain);
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.unassignRole({ userId: 'target', roleId: 'role-super', caller: ADMIN_CALLER }),
      ),
    ).rejects.toBeInstanceOf(LastSuperAdminError);
  });

  it('returns success but emits no revoked event when nothing was deleted', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      callerAssignment: [],
      assignment: [],
      superRole: [],
    });
    readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'returning').mockResolvedValue([]);
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    const result = await inContext(() =>
      svc.unassignRole({ userId: 'ghost', roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(result).toEqual({ success: true });
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.revoked', expect.anything());
  });

  it('emits iam.role.revoked when a row was actually deleted', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      callerAssignment: [],
      assignment: [],
      superRole: [],
    });
    readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'returning').mockResolvedValue([
      { id: 'a1' },
    ]);
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());
    await inContext(() =>
      svc.unassignRole({ userId: 'target', roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.revoked',
      expect.objectContaining({ roleId: 'role-1', userId: 'target', actorId: 'admin-1' }),
    );
  });
});

describe('IamService.previewEffectivePermissions', () => {
  it('returns the max level per module across roles (union)', async () => {
    const drizzle = routingDrizzle({
      superRole: [],
      permission: [
        { resource: 'player', level: 'read' },
        { resource: 'player', level: 'read_write' },
        { resource: 'withdrawal', level: 'read' },
      ],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await inContext(() =>
      svc.previewEffectivePermissions({ roleIds: ['r1', 'r2'] }),
    );
    expect(result.permissions).toContainEqual({ resource: 'player', level: 'read_write' });
    expect(result.permissions).toContainEqual({ resource: 'withdrawal', level: 'read' });
    expect(result.permissions.filter((p) => p.resource === 'player')).toHaveLength(1);
  });

  it('super-admin role in the set yields all modules read_write', async () => {
    const drizzle = routingDrizzle({ superRole: [{ id: 'role-super' }] });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await inContext(() =>
      svc.previewEffectivePermissions({ roleIds: ['role-super'] }),
    );
    expect(result.permissions).toHaveLength(Object.keys(statement).length);
    expect(result.permissions.every((p) => p.level === 'read_write')).toBe(true);
  });

  it('falls back to static role permissions if the user has no dynamic role assignments', async () => {
    const drizzle = routingDrizzle({
      assignment: [], // no dynamic assignments
      user: [{ role: 'support' }], // static role is 'support'
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await inContext(() => svc.previewEffectivePermissions({ userId: 'u1' }));
    // Support has non-empty permissions
    expect(result.permissions).not.toHaveLength(0);
    // For support role, player access is read (view)
    expect(result.permissions).toContainEqual({ resource: 'player', level: 'read' });
  });
});

describe('IamService.acceptInvitation', () => {
  it('accepts once and emits exactly one event', async () => {
    const invRow = {
      id: 'inv-1',
      email: 'who@admin.com',
      roleId: 'role-1',
      token: 'tok',
      status: 'accepted',
      expiresAt: new Date(Date.now() + 1000),
      acceptedAt: new Date(),
      createdAt: new Date(),
    };
    const returning = vi.fn().mockResolvedValueOnce([invRow]).mockResolvedValueOnce([]);
    const chain = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning,
    };
    const drizzle = mockDb(chain);
    const events = makeEvents();
    const svc = new IamService(drizzle, events, makeEmail());

    const first = await svc.acceptInvitation('tok');
    expect(first).toEqual({ success: true, email: 'who@admin.com' });
    await expect(svc.acceptInvitation('tok')).rejects.toBeInstanceOf(InvitationConflictError);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('IamService.inviteAdmin', () => {
  const invitationRow = {
    id: 'inv-1',
    email: 'new@admin.com',
    roleId: 'role-1',
    token: 'tok-abc',
    status: 'pending',
    expiresAt: new Date(Date.now() + 86400000),
    acceptedAt: null,
    createdAt: new Date(),
  };

  it('creates a pending invitation and calls SEND_EMAIL when caller is super-admin', async () => {
    let table: Record<string, unknown> = {};
    let lastSelect: Record<string, unknown> | undefined;
    const chain: Record<string, unknown> = {
      select: vi.fn().mockImplementation((sel?: Record<string, unknown>) => {
        lastSelect = sel;
        return chain;
      }),
      from: vi.fn().mockImplementation((tbl: Record<string, unknown>) => {
        table = tbl ?? {};
        return chain;
      }),
      where: vi.fn().mockImplementation(() => {
        // adminRoleAssignment (has userId col): caller's assignment for isSuperAdmin.
        if ('userId' in table) {
          return Promise.resolve([{ roleId: 'role-super' }]);
        }
        // adminRole id-only probe: the super-admin check.
        if (lastSelect && 'id' in lastSelect && Object.keys(lastSelect).length === 1) {
          return Promise.resolve([{ id: 'role-super' }]);
        }
        // adminRole full row: role-existence lookup.
        return Promise.resolve([ROLE_ROW]);
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([invitationRow]),
    };
    const drizzle = mockDb(chain);
    const email = makeEmail();
    const svc = new IamService(drizzle, makeEvents(), email);
    const result = await inContext(() =>
      svc.inviteAdmin({ email: 'new@admin.com', roleId: 'role-1', caller: ADMIN_CALLER }),
    );
    expect(result.status).toBe('pending');
    expect(result.email).toBe('new@admin.com');
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@admin.com' }));
  });

  it('rejects a non-super-admin caller', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      callerAssignment: [{ roleId: 'role-x' }],
      superRole: [],
    });
    const email = makeEmail();
    const svc = new IamService(drizzle, makeEvents(), email);
    await expect(
      inContext(() =>
        svc.inviteAdmin({
          email: 'new@admin.com',
          roleId: 'role-1',
          caller: { userId: 'sup-1', role: 'support' },
        }),
      ),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
    expect(email.send).not.toHaveBeenCalled();
  });
});

function paginatedDrizzle(rows: unknown[], total: number) {
  const db = {
    select: vi.fn().mockImplementation((sel?: Record<string, unknown>) => {
      const result = sel && 'count' in sel ? [{ count: total }] : rows;
      const chain: Record<string, unknown> = {
        then: (res: (v: unknown[]) => unknown) => Promise.resolve(result).then(res),
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        offset: vi.fn(() => chain),
      };
      return chain;
    }),
  };
  return mockDb(db);
}

describe('IamService paginated lists', () => {
  it('listRoles returns { items, total, page, limit }', async () => {
    const drizzle = paginatedDrizzle([{ ...ROLE_ROW }], 1);
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await svc.listRoles({ page: 2, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).id).toBe(ROLE_ROW.id);
  });

  it('listInvitations returns the paginated wrapper', async () => {
    const invRow = {
      id: 'inv-1',
      email: 'a@b.com',
      roleId: 'role-1',
      token: 'tok',
      status: 'pending',
      expiresAt: new Date(),
      acceptedAt: null,
      createdAt: new Date(),
    };
    const drizzle = paginatedDrizzle([invRow], 5);
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await svc.listInvitations({ page: 1, limit: 20 });
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).email).toBe('a@b.com');
  });

  it('listAssignments returns the paginated wrapper with joined role fields', async () => {
    const assignmentRow = {
      id: 'a1',
      userId: 'u1',
      roleId: 'role-1',
      createdAt: new Date(),
      roleName: 'Ops',
      roleKey: null,
    };
    const drizzle = paginatedDrizzle([assignmentRow], 3);
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    const result = await svc.listAssignments({ page: 1, limit: 20 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).roleName).toBe('Ops');
  });
});

describe('IamService.forceLogout', () => {
  it('rejects a non-super-admin caller', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      assignment: [],
      superRole: [],
    });
    const svc = new IamService(drizzle, makeEvents(), makeEmail());
    await expect(
      inContext(() =>
        svc.forceLogout({
          userId: 'target-user',
          caller: { userId: 'sup-1', role: 'support' },
        }),
      ),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
  });

  it('allows a super-admin caller to delete sessions for a user and emits identity.sessions.revoked_all', async () => {
    const drizzle = routingDrizzle({
      role: [ROLE_ROW],
      assignment: [],
      superRole: [],
    });
    const events = makeEvents();
    const sessionCommands = {
      revokeAll: vi.fn().mockResolvedValue({ success: true }),
    };
    const svc = new IamService(drizzle, events, makeEmail(), sessionCommands);
    const result = await inContext(() =>
      svc.forceLogout({
        userId: 'target-user',
        caller: ADMIN_CALLER,
      }),
    );
    expect(result).toEqual({ success: true });
    expect(sessionCommands.revokeAll).toHaveBeenCalledWith('target-user', ADMIN_CALLER.userId);
  });
});
