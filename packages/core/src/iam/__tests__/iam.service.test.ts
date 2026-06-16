import { describe, it, expect, vi } from 'vitest';
import * as core from '@oss/core/server';
import {
  IamService,
  DbAdminPermissionResolver,
  RoleNotFoundError,
  InvalidGrantError,
  GrantEscalationError,
  InvitationConflictError,
} from '../service/iam.service.js';

// Tag tenant-equality predicates so the mock `where` can read the active tenant.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((col: unknown, val: unknown) => {
      const colName = (col as { name?: string })?.name;
      return colName === 'tenantId' ? { __tenant: val } : { col, val };
    }),
  };
});

// Minimal drizzle mock that chains select/from/where/insert/values/returning.
function makeDrizzle(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    ...overrides,
  };
  return { db: chain } as unknown as import('@oss/core/server').DrizzleService;
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() } as unknown as import('@oss/core/server').EventBus;
}

function makeEmail() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('@oss/core/contracts').SendEmailPort;
}

const TENANT = 'test-tenant';

// Run fn inside a tenant ALS frame so getCurrentTenantId() resolves per-call.
function inTenant<T>(tenantId: string, fn: () => T): T {
  return core.withTenant({ tenantId, userId: 'caller', traceId: 't' }, fn);
}

// A full-admin caller (holds the entire catalog via the static 'admin' role).
const ADMIN_CALLER = { userId: 'admin-1', role: 'admin' };

// --- DbAdminPermissionResolver ---

describe('DbAdminPermissionResolver', () => {
  it('returns null when user has no assignment', async () => {
    const drizzle = makeDrizzle();
    const resolver = new DbAdminPermissionResolver(drizzle);
    const result = await inTenant(TENANT, () => resolver.getGrants('user-no-role'));
    expect(result).toBeNull();
  });

  it('returns grants when user has an assignment', async () => {
    // First where call returns an assignment row; second (per-role) returns permission rows.
    let callCount = 0;
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // assignments query
          return Promise.resolve([{ roleId: 'role-1' }]);
        }
        // permissions query
        return Promise.resolve([
          { resource: 'player', action: 'view' },
          { resource: 'audit', action: 'view' },
        ]);
      }),
    };
    const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
    const resolver = new DbAdminPermissionResolver(drizzle);
    const grants = await inTenant(TENANT, () => resolver.getGrants('user-with-role'));
    expect(grants).not.toBeNull();
    expect(grants).toHaveLength(2);
    expect(grants![0]).toEqual({ resource: 'player', action: 'view' });
  });

  it('resolves the tenant per call (not frozen) - filters assignments by the active frame', async () => {
    const { eq } = await import('drizzle-orm');
    const eqMock = vi.mocked(eq);
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
    const resolver = new DbAdminPermissionResolver(drizzle);

    // The tagged tenant predicate (`{ __tenant }`) is produced by the mocked eq()
    // for the tenantId column. Reading the latest one proves getGrants resolved the
    // tenant from the ACTIVE frame on each call, not a constructor-frozen value.
    const lastTenant = () =>
      eqMock.mock.results
        .map((r) => r.value as { __tenant?: string })
        .filter((v) => v && '__tenant' in v)
        .at(-1)?.__tenant;

    await inTenant('tenant-A', () => resolver.getGrants('u'));
    expect(lastTenant()).toBe('tenant-A');
    await inTenant('tenant-B', () => resolver.getGrants('u'));
    expect(lastTenant()).toBe('tenant-B');
  });
});

// --- IamService ---

// Role row used by the role-exists check.
const ROLE_ROW = {
  id: 'role-1',
  tenantId: TENANT,
  name: 'Ops',
  description: null,
  createdAt: new Date(),
};

describe('IamService', () => {
  describe('setRolePermissions', () => {
    it('throws RoleNotFoundError when role does not exist', async () => {
      const drizzle = makeDrizzle();
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      await expect(
        inTenant(TENANT, () =>
          svc.setRolePermissions({
            roleId: 'missing',
            grants: [{ resource: 'player', action: 'view' }],
            caller: ADMIN_CALLER,
          }),
        ),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('throws InvalidGrantError for unknown (resource, action)', async () => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([ROLE_ROW]),
        delete: vi.fn().mockReturnThis(),
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      await expect(
        inTenant(TENANT, () =>
          svc.setRolePermissions({
            roleId: 'role-1',
            grants: [{ resource: 'nonexistent', action: 'fly' }],
            caller: ADMIN_CALLER,
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it('rejects escalation: caller cannot grant a permission they do not hold', async () => {
      // Role exists; caller has NO DB assignment (where for assignments -> []),
      // and is a static 'support' role which lacks withdrawal:approve.
      let call = 0;
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          call++;
          if (call === 1) return Promise.resolve([ROLE_ROW]); // role-exists
          return Promise.resolve([]); // caller assignments -> none -> static fallback
        }),
        delete: vi.fn().mockReturnThis(),
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      await expect(
        inTenant(TENANT, () =>
          svc.setRolePermissions({
            roleId: 'role-1',
            grants: [{ resource: 'withdrawal', action: 'approve' }],
            caller: { userId: 'sup-1', role: 'support' },
          }),
        ),
      ).rejects.toBeInstanceOf(GrantEscalationError);
    });

    it('allows a full admin to grant any catalog permission (subset holds)', async () => {
      // Route query results by the table passed to from(), so call order is
      // irrelevant. adminRole -> role row; adminRoleAssignment -> none (static
      // admin fallback grants everything); adminRolePermission -> the saved grant.
      let table: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockImplementation((tbl: Record<string, unknown>) => {
          // Route by the columns present on the Drizzle table object so call order
          // is irrelevant: permission table has `resource`, assignment has `userId`.
          table = tbl ?? {};
          return chain;
        }),
        where: vi.fn().mockImplementation(() => {
          if ('resource' in table) {
            return Promise.resolve([
              {
                id: 'p1',
                roleId: 'role-1',
                resource: 'withdrawal',
                action: 'approve',
                createdAt: new Date(),
              },
            ]);
          }
          if ('userId' in table) return Promise.resolve([]); // assignments
          return Promise.resolve([ROLE_ROW]); // adminRole
        }),
        delete: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      const result = await inTenant(TENANT, () =>
        svc.setRolePermissions({
          roleId: 'role-1',
          grants: [{ resource: 'withdrawal', action: 'approve' }],
          caller: ADMIN_CALLER,
        }),
      );
      expect(result.permissions).toHaveLength(1);
    });
  });

  describe('assignRole', () => {
    it('rejects escalation: caller cannot assign a role more powerful than their own grants', async () => {
      // Target role has withdrawal:approve; caller is static 'support' (no such grant).
      let call = 0;
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          call++;
          if (call === 1) return Promise.resolve([ROLE_ROW]); // role-exists
          if (call === 2) return Promise.resolve([{ resource: 'withdrawal', action: 'approve' }]); // role grants
          return Promise.resolve([]); // caller assignments -> static support
        }),
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      await expect(
        inTenant(TENANT, () =>
          svc.assignRole({
            userId: 'target',
            roleId: 'role-1',
            caller: { userId: 'sup-1', role: 'support' },
          }),
        ),
      ).rejects.toBeInstanceOf(GrantEscalationError);
    });
  });

  describe('deleteRole', () => {
    it('deletes the role permissions then the role', async () => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([ROLE_ROW]),
        delete: vi.fn().mockReturnThis(),
      };
      // delete().where() must resolve; make where terminal after delete by reusing it.
      (chain.where as ReturnType<typeof vi.fn>).mockResolvedValue([ROLE_ROW]);
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const svc = new IamService(drizzle, makeEvents(), makeEmail());
      const result = await inTenant(TENANT, () => svc.deleteRole('role-1'));
      expect(result).toEqual({ success: true });
      expect(chain.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('acceptInvitation', () => {
    it('accepts once via a single conditional UPDATE and emits exactly one event', async () => {
      const invRow = {
        id: 'inv-1',
        tenantId: TENANT,
        email: 'who@admin.com',
        roleId: 'role-1',
        token: 'tok',
        status: 'accepted',
        expiresAt: new Date(Date.now() + 1000),
        acceptedAt: new Date(),
        createdAt: new Date(),
      };
      // First accept: UPDATE..returning yields the row. Second accept: returns [].
      const returning = vi.fn().mockResolvedValueOnce([invRow]).mockResolvedValueOnce([]);
      const chain = {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning,
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const events = makeEvents();
      const svc = new IamService(drizzle, events, makeEmail());

      const first = await svc.acceptInvitation('tok');
      expect(first).toEqual({ success: true, email: 'who@admin.com' });

      // Replay: zero rows updated -> conflict, no second emit.
      await expect(svc.acceptInvitation('tok')).rejects.toBeInstanceOf(InvitationConflictError);
      expect(events.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('inviteAdmin', () => {
    it('creates a pending invitation and calls SEND_EMAIL', async () => {
      const invitationRow = {
        id: 'inv-1',
        tenantId: TENANT,
        email: 'new@admin.com',
        roleId: 'role-1',
        token: 'tok-abc',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86400000),
        acceptedAt: null,
        createdAt: new Date(),
      };

      let callCount = 0;
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // role existence check
            return Promise.resolve([
              {
                id: 'role-1',
                tenantId: TENANT,
                name: 'Ops',
                description: null,
                createdAt: new Date(),
              },
            ]);
          }
          return Promise.resolve([invitationRow]);
        }),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([invitationRow]),
      };
      const drizzle = { db: chain } as unknown as import('@oss/core/server').DrizzleService;
      const email = makeEmail();
      const svc = new IamService(drizzle, makeEvents(), email);

      const result = await inTenant(TENANT, () =>
        svc.inviteAdmin({ email: 'new@admin.com', roleId: 'role-1' }),
      );

      expect(result.status).toBe('pending');
      expect(result.email).toBe('new@admin.com');
      expect(email.send).toHaveBeenCalledOnce();
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@admin.com' }));
    });
  });
});
