import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { mock, NO_CLIENT_META, makeEventBus } from '../../testing/mock.js';
import { statement, findOneOrThrow, RedisCache, type ResourceName } from '@openora/core/server';
import type { SendEmailPort, SessionCommands } from '@openora/core/contracts';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { migrate as migrateIam } from '@openora/core/iam/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { user } from '@openora/core/pam/schema/identity';
import {
  adminRole,
  adminRolePermission,
  adminRoleAssignment,
  adminInvitation,
} from '../schema/index.js';
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

let db: TestDb;
let redis: TestRedis;

const makeEmail = () => mock<SendEmailPort>({ send: vi.fn().mockResolvedValue(undefined) });

// Bootstrap super-admin: no DB assignment row + user.role === 'admin' passes the static fallback.
const ADMIN_CALLER = { userId: randomUUID(), role: 'admin', ...NO_CLIENT_META };
const SUPPORT_CALLER = { userId: randomUUID(), role: 'support', ...NO_CLIENT_META };

const TOTAL_GRANTS = (Object.keys(statement) as ResourceName[]).reduce(
  (n, r) => n + (statement[r] as readonly string[]).length,
  0,
);

async function seedRole(
  overrides: { name?: string; key?: string; isSystem?: boolean; isSuperAdmin?: boolean } = {},
) {
  const [row] = await db.drizzle.db
    .insert(adminRole)
    .values({
      name: overrides.name ?? 'Ops',
      key: overrides.key ?? null,
      isSystem: overrides.isSystem ?? false,
      isSuperAdmin: overrides.isSuperAdmin ?? false,
    })
    .returning();
  return row;
}

async function seedUser(role: string) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name: 'U', email: `${randomUUID()}@x.dev`, role })
    .returning();
  return row;
}

async function seedAssignment(userId: string, roleId: string) {
  await db.drizzle.db.insert(adminRoleAssignment).values({ userId, roleId });
}

async function seedPermission(
  roleId: string,
  resource: string,
  level: 'no_access' | 'read' | 'read_write',
) {
  await db.drizzle.db.insert(adminRolePermission).values({ roleId, resource, level });
}

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${adminRole}, ${adminRolePermission}, ${adminRoleAssignment}, ${adminInvitation}, ${user} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('IamService.listCatalog', () => {
  it('omits the admin module from the assignable catalog', () => {
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const catalog = svc.listCatalog();
    expect(catalog.modules.some((m) => m.resource === 'admin')).toBe(false);
    expect(catalog.modules.some((m) => m.resource === 'player')).toBe(true);
  });
});

describe('DbAdminPermissionResolver (real PG)', () => {
  it('returns null when the user has no assignment', async () => {
    const resolver = new DbAdminPermissionResolver(db.drizzle);
    expect(await resolver.getGrants(randomUUID())).toBeNull();
  });

  it('super-admin assignment returns ALL grants (bypass)', async () => {
    const role = await seedRole({ isSuperAdmin: true });
    const userId = randomUUID();
    await seedAssignment(userId, role.id);

    const grants = await new DbAdminPermissionResolver(db.drizzle).getGrants(userId);
    expect(grants).toHaveLength(TOTAL_GRANTS);
  });

  it('expands stored level rows into action grants', async () => {
    const role = await seedRole();
    await seedPermission(role.id, 'player', 'read');
    await seedPermission(role.id, 'withdrawal', 'read_write');
    const userId = randomUUID();
    await seedAssignment(userId, role.id);

    const grants = await new DbAdminPermissionResolver(db.drizzle).getGrants(userId);
    expect(grants).toContainEqual({ resource: 'player', action: 'view' });
    expect(grants).toContainEqual({ resource: 'withdrawal', action: 'approve' });
    // read player must NOT yield write actions.
    expect(grants).not.toContainEqual({ resource: 'player', action: 'ban' });
  });
});

describe('DbAdminPermissionResolver caching (real Redis read-through)', () => {
  it('serves a repeat lookup from cache even after the underlying rows change', async () => {
    const role = await seedRole({ isSuperAdmin: true });
    const userId = randomUUID();
    await seedAssignment(userId, role.id);
    const resolver = new DbAdminPermissionResolver(db.drizzle, new RedisCache(redis.client));

    expect(await resolver.getGrants(userId)).toHaveLength(TOTAL_GRANTS);

    // Revoke in the DB behind the cache's back; the cached grants must still be served.
    await db.drizzle.db.delete(adminRoleAssignment).where(eq(adminRoleAssignment.userId, userId));
    expect(await resolver.getGrants(userId)).toHaveLength(TOTAL_GRANTS);
  });

  it('without a cache, every lookup re-queries the DB', async () => {
    const role = await seedRole({ isSuperAdmin: true });
    const userId = randomUUID();
    await seedAssignment(userId, role.id);
    const resolver = new DbAdminPermissionResolver(db.drizzle);

    expect(await resolver.getGrants(userId)).toHaveLength(TOTAL_GRANTS);
    await db.drizzle.db.delete(adminRoleAssignment).where(eq(adminRoleAssignment.userId, userId));
    expect(await resolver.getGrants(userId)).toBeNull();
  });

  it('invalidateUser purges so the next lookup reflects the revoke', async () => {
    const role = await seedRole({ isSuperAdmin: true });
    const userId = randomUUID();
    await seedAssignment(userId, role.id);
    const resolver = new DbAdminPermissionResolver(db.drizzle, new RedisCache(redis.client));

    await resolver.getGrants(userId);
    await db.drizzle.db.delete(adminRoleAssignment).where(eq(adminRoleAssignment.userId, userId));
    await resolver.invalidateUser(userId);
    expect(await resolver.getGrants(userId)).toBeNull();
  });

  it('invalidateRole purges every current holder of the role', async () => {
    const role = await seedRole();
    await seedPermission(role.id, 'player', 'read');
    const u1 = randomUUID();
    const u2 = randomUUID();
    await seedAssignment(u1, role.id);
    await seedAssignment(u2, role.id);
    const resolver = new DbAdminPermissionResolver(db.drizzle, new RedisCache(redis.client));

    // Prime both users' caches at the 'read' level (just the view action).
    expect(await resolver.getGrants(u1)).toEqual([{ resource: 'player', action: 'view' }]);
    expect(await resolver.getGrants(u2)).toEqual([{ resource: 'player', action: 'view' }]);

    // Widen the role to read_write, then invalidate every holder.
    await db.drizzle.db
      .update(adminRolePermission)
      .set({ level: 'read_write' })
      .where(eq(adminRolePermission.roleId, role.id));
    await resolver.invalidateRole(role.id);

    for (const uid of [u1, u2]) {
      const grants = await resolver.getGrants(uid);
      expect(grants).toContainEqual({ resource: 'player', action: 'ban' });
    }
  });
});

describe('IamService.setRolePermissions', () => {
  it('rejects a non-super-admin caller and audits the denial', async () => {
    const role = await seedRole();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());
    await expect(
      svc.setRolePermissions({
        roleId: role.id,
        grants: [{ resource: 'player', level: 'read' }],
        caller: SUPPORT_CALLER,
      }),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: SUPPORT_CALLER.userId,
        resource: 'admin',
        action: 'update',
        role: 'support',
      }),
    );
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.setRolePermissions({
        roleId: randomUUID(),
        grants: [{ resource: 'player', level: 'read' }],
        caller: ADMIN_CALLER,
      }),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
  });

  it('throws InvalidGrantError for an unknown module', async () => {
    const role = await seedRole();
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.setRolePermissions({
        roleId: role.id,
        grants: [{ resource: 'nonexistent', level: 'read' } as never],
        caller: ADMIN_CALLER,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('rejects a grant targeting the admin module (super-admin-only, A6)', async () => {
    const role = await seedRole();
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.setRolePermissions({
        roleId: role.id,
        grants: [{ resource: 'admin', level: 'read_write' }],
        caller: ADMIN_CALLER,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('blocks editing a super-admin role (always full)', async () => {
    const role = await seedRole({ isSuperAdmin: true, isSystem: true });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.setRolePermissions({
        roleId: role.id,
        grants: [{ resource: 'player', level: 'read' }],
        caller: ADMIN_CALLER,
      }),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('a super caller may grant any level and the rows are persisted', async () => {
    const role = await seedRole();
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.setRolePermissions({
      roleId: role.id,
      grants: [{ resource: 'withdrawal', level: 'read_write' }],
      caller: ADMIN_CALLER,
    });
    expect(result.permissions).toContainEqual({ resource: 'withdrawal', level: 'read_write' });

    const rows = await db.drizzle.db
      .select()
      .from(adminRolePermission)
      .where(eq(adminRolePermission.roleId, role.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource: 'withdrawal', level: 'read_write' });
  });

  it('emits iam.role.permissions.changed with actorId', async () => {
    const role = await seedRole();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());
    await svc.setRolePermissions({
      roleId: role.id,
      grants: [{ resource: 'player', level: 'read' }],
      caller: ADMIN_CALLER,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.permissions.changed',
      expect.objectContaining({ roleId: role.id, actorId: ADMIN_CALLER.userId }),
    );
  });
});

describe('IamService.updateRole', () => {
  it('blocks renaming the super-admin role', async () => {
    const role = await seedRole({ isSuperAdmin: true, isSystem: true });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.updateRole({ roleId: role.id, name: 'Renamed', caller: ADMIN_CALLER }),
    ).rejects.toBeInstanceOf(ProtectedRoleError);
  });

  it('allows renaming a predefined (isSystem, non-super) role', async () => {
    const role = await seedRole({ isSystem: true, isSuperAdmin: false });
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());
    const result = await svc.updateRole({ roleId: role.id, name: 'Renamed', caller: ADMIN_CALLER });
    expect(result.name).toBe('Renamed');
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.updated',
      expect.objectContaining({ roleId: role.id, actorId: ADMIN_CALLER.userId }),
    );

    const [row] = await db.drizzle.db.select().from(adminRole).where(eq(adminRole.id, role.id));
    expect(row.name).toBe('Renamed');
  });
});

describe('IamService.deleteRole', () => {
  it('blocks deleting a system role', async () => {
    const role = await seedRole({ isSystem: true });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(svc.deleteRole({ roleId: role.id, caller: ADMIN_CALLER })).rejects.toBeInstanceOf(
      ProtectedRoleError,
    );
  });

  it('blocks deleting a super-admin role', async () => {
    const role = await seedRole({ isSuperAdmin: true });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(svc.deleteRole({ roleId: role.id, caller: ADMIN_CALLER })).rejects.toBeInstanceOf(
      ProtectedRoleError,
    );
  });

  it('deletes a custom role with no assignments and emits only iam.role.deleted', async () => {
    const role = await seedRole();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());
    const result = await svc.deleteRole({ roleId: role.id, caller: ADMIN_CALLER });
    expect(result).toEqual({ success: true });
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.deleted',
      expect.objectContaining({ roleId: role.id, actorId: ADMIN_CALLER.userId }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.revoked', expect.anything());

    expect(
      await db.drizzle.db.select().from(adminRole).where(eq(adminRole.id, role.id)),
    ).toHaveLength(0);
  });

  it('emits iam.role.revoked once per affected user plus iam.role.deleted, and cascades assignments', async () => {
    const role = await seedRole();
    const userA = randomUUID();
    const userB = randomUUID();
    await seedAssignment(userA, role.id);
    await seedAssignment(userB, role.id);
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());

    const result = await svc.deleteRole({ roleId: role.id, caller: ADMIN_CALLER });
    expect(result).toEqual({ success: true });
    expect(events.emit).toHaveBeenCalledWith('iam.role.revoked', {
      roleId: role.id,
      userId: userA,
      actorId: ADMIN_CALLER.userId,
      ...NO_CLIENT_META,
    });
    expect(events.emit).toHaveBeenCalledWith('iam.role.revoked', {
      roleId: role.id,
      userId: userB,
      actorId: ADMIN_CALLER.userId,
      ...NO_CLIENT_META,
    });
    const revokeCalls = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'iam.role.revoked',
    );
    expect(revokeCalls).toHaveLength(2);
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.deleted',
      expect.objectContaining({ roleId: role.id, actorId: ADMIN_CALLER.userId }),
    );
    // ON DELETE CASCADE removed the assignment rows.
    expect(await db.drizzle.db.select().from(adminRoleAssignment)).toHaveLength(0);
  });
});

describe('IamService.assignRole', () => {
  it('dedupes an existing assignment without inserting again (unique index)', async () => {
    const role = await seedRole();
    const target = await seedUser('admin');
    await seedAssignment(target.id, role.id);
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());

    const result = await svc.assignRole({
      userId: target.id,
      roleId: role.id,
      caller: ADMIN_CALLER,
    });
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.assigned', expect.anything());
    // Still exactly one assignment row, and the existing one was returned.
    const rows = await db.drizzle.db.select().from(adminRoleAssignment);
    expect(rows).toHaveLength(1);
    expect(result.id).toBe(rows[0].id);
  });

  it('rejects assigning a role to a non-admin (player) account', async () => {
    const role = await seedRole();
    const player = await seedUser('player');
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.assignRole({ userId: player.id, roleId: role.id, caller: ADMIN_CALLER }),
    ).rejects.toThrow(NotAnAdminUserError);
  });

  it('rejects assigning a role to an unknown user', async () => {
    const role = await seedRole();
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.assignRole({ userId: randomUUID(), roleId: role.id, caller: ADMIN_CALLER }),
    ).rejects.toThrow(AdminUserNotFoundError);
  });

  it('the unique index keeps two concurrent assigns from double-inserting', async () => {
    const role = await seedRole();
    const target = await seedUser('admin');
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());

    await Promise.allSettled([
      svc.assignRole({ userId: target.id, roleId: role.id, caller: ADMIN_CALLER }),
      svc.assignRole({ userId: target.id, roleId: role.id, caller: ADMIN_CALLER }),
    ]);

    const rows = await db.drizzle.db
      .select()
      .from(adminRoleAssignment)
      .where(eq(adminRoleAssignment.userId, target.id));
    expect(rows).toHaveLength(1);
  });
});

describe('IamService.unassignRole', () => {
  it('rejects removing the last super-admin holder', async () => {
    const superRole = await seedRole({ isSuperAdmin: true, isSystem: true });
    const target = randomUUID();
    await seedAssignment(target, superRole.id);
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());

    await expect(
      svc.unassignRole({ userId: target, roleId: superRole.id, caller: ADMIN_CALLER }),
    ).rejects.toBeInstanceOf(LastSuperAdminError);
    // The holder survives the rejected unassign.
    expect(await db.drizzle.db.select().from(adminRoleAssignment)).toHaveLength(1);
  });

  it('returns success but emits no revoked event when nothing was deleted', async () => {
    const role = await seedRole();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());
    const result = await svc.unassignRole({
      userId: randomUUID(),
      roleId: role.id,
      caller: ADMIN_CALLER,
    });
    expect(result).toEqual({ success: true });
    expect(events.emit).not.toHaveBeenCalledWith('iam.role.revoked', expect.anything());
  });

  it('emits iam.role.revoked when a row was actually deleted', async () => {
    const role = await seedRole();
    const target = randomUUID();
    await seedAssignment(target, role.id);
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());

    await svc.unassignRole({ userId: target, roleId: role.id, caller: ADMIN_CALLER });
    expect(events.emit).toHaveBeenCalledWith(
      'iam.role.revoked',
      expect.objectContaining({ roleId: role.id, userId: target, actorId: ADMIN_CALLER.userId }),
    );
    expect(await db.drizzle.db.select().from(adminRoleAssignment)).toHaveLength(0);
  });

  it('under two concurrent unassigns of a two-holder super role, exactly one wins (FOR UPDATE guard)', async () => {
    const superRole = await seedRole({ isSuperAdmin: true, isSystem: true });
    const userA = randomUUID();
    const userB = randomUUID();
    await seedAssignment(userA, superRole.id);
    await seedAssignment(userB, superRole.id);
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());

    const results = await Promise.allSettled([
      svc.unassignRole({ userId: userA, roleId: superRole.id, caller: ADMIN_CALLER }),
      svc.unassignRole({ userId: userB, roleId: superRole.id, caller: ADMIN_CALLER }),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastSuperAdminError);
    // Exactly one super-admin holder survives - the guard never let both strip it.
    expect(await db.drizzle.db.select().from(adminRoleAssignment)).toHaveLength(1);
  });
});

describe('IamService.previewEffectivePermissions', () => {
  it('returns the max level per module across roles (union)', async () => {
    const roleA = await seedRole();
    const roleB = await seedRole();
    await seedPermission(roleA.id, 'player', 'read');
    await seedPermission(roleA.id, 'withdrawal', 'read');
    await seedPermission(roleB.id, 'player', 'read_write');
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());

    const result = await svc.previewEffectivePermissions({ roleIds: [roleA.id, roleB.id] });
    expect(result.permissions).toContainEqual({ resource: 'player', level: 'read_write' });
    expect(result.permissions).toContainEqual({ resource: 'withdrawal', level: 'read' });
    expect(result.permissions.filter((p) => p.resource === 'player')).toHaveLength(1);
  });

  it('super-admin role in the set yields all modules read_write', async () => {
    const superRole = await seedRole({ isSuperAdmin: true });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.previewEffectivePermissions({ roleIds: [superRole.id] });
    expect(result.permissions).toHaveLength(Object.keys(statement).length);
    expect(result.permissions.every((p) => p.level === 'read_write')).toBe(true);
  });

  it('falls back to static role permissions when the user has no dynamic role assignments', async () => {
    const u = await seedUser('support');
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.previewEffectivePermissions({ userId: u.id });
    expect(result.permissions).not.toHaveLength(0);
    expect(result.permissions).toContainEqual({ resource: 'player', level: 'read' });
  });
});

describe('IamService.acceptInvitation', () => {
  async function seedInvitation() {
    const role = await seedRole();
    const token = randomUUID();
    await db.drizzle.db.insert(adminInvitation).values({
      email: 'who@admin.com',
      roleId: role.id,
      token,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    return token;
  }

  it('accepts once and emits exactly one event; a replay conflicts and emits nothing more', async () => {
    const token = await seedInvitation();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());

    const first = await svc.acceptInvitation(token);
    expect(first).toEqual({ success: true, email: 'who@admin.com' });
    await expect(svc.acceptInvitation(token)).rejects.toBeInstanceOf(InvitationConflictError);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('two concurrent accepts: exactly one succeeds, one event (atomic conditional UPDATE)', async () => {
    const token = await seedInvitation();
    const events = makeEventBus();
    const svc = new IamService(db.drizzle, events, makeEmail());

    const results = await Promise.allSettled([
      svc.acceptInvitation(token),
      svc.acceptInvitation(token),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvitationConflictError);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('IamService.inviteAdmin', () => {
  it('creates a pending invitation and calls SEND_EMAIL when caller is super-admin', async () => {
    const role = await seedRole();
    const email = makeEmail();
    const svc = new IamService(db.drizzle, makeEventBus(), email);
    const result = await svc.inviteAdmin({
      email: 'new@admin.com',
      roleId: role.id,
      caller: ADMIN_CALLER,
    });
    expect(result.status).toBe('pending');
    expect(result.email).toBe('new@admin.com');
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@admin.com' }));

    const rows = await db.drizzle.db.select().from(adminInvitation);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'new@admin.com', status: 'pending' });
  });

  it('rejects a non-super-admin caller', async () => {
    const role = await seedRole();
    const email = makeEmail();
    const svc = new IamService(db.drizzle, makeEventBus(), email);
    await expect(
      svc.inviteAdmin({ email: 'new@admin.com', roleId: role.id, caller: SUPPORT_CALLER }),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('IamService paginated lists', () => {
  it('listRoles returns { items, total, page, limit }', async () => {
    const role = await seedRole();
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.listRoles({ page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).id).toBe(role.id);
  });

  it('listInvitations returns the paginated wrapper', async () => {
    const role = await seedRole();
    await db.drizzle.db.insert(adminInvitation).values({
      email: 'a@b.com',
      roleId: role.id,
      token: randomUUID(),
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.listInvitations({ page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).email).toBe('a@b.com');
  });

  it('listAssignments returns the paginated wrapper with joined role fields', async () => {
    const role = await seedRole({ name: 'Ops' });
    await seedAssignment(randomUUID(), role.id);
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    const result = await svc.listAssignments({ page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(findOneOrThrow(result.items, new Error('expected an item')).roleName).toBe('Ops');
  });
});

describe('IamService.forceLogout', () => {
  it('rejects a non-super-admin caller', async () => {
    const svc = new IamService(db.drizzle, makeEventBus(), makeEmail());
    await expect(
      svc.forceLogout({ userId: randomUUID(), caller: SUPPORT_CALLER }),
    ).rejects.toBeInstanceOf(NotSuperAdminError);
  });

  it('allows a super-admin caller to delete sessions for a user via SessionCommands', async () => {
    const events = makeEventBus();
    const sessionCommands = mock<SessionCommands>({
      revokeAll: vi.fn().mockResolvedValue({ success: true }),
    });
    const svc = new IamService(db.drizzle, events, makeEmail(), sessionCommands);
    const targetUserId = randomUUID();
    const result = await svc.forceLogout({ userId: targetUserId, caller: ADMIN_CALLER });
    expect(result).toEqual({ success: true });
    expect(sessionCommands.revokeAll).toHaveBeenCalledWith(targetUserId, ADMIN_CALLER.userId);
  });
});
