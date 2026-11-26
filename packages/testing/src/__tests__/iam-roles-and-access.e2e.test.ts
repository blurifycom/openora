import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  AdminInvitationSchema,
  AdminRoleAssignmentSchema,
  AdminRoleSchema,
  AdminRoleWithGrantsSchema,
  EffectivePermissionsSchema,
} from '@openora/core/iam/contract';
import {
  adminInvitation,
  adminRole,
  adminRoleAssignment,
  adminRolePermission,
} from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asPlayer,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  newStaff,
  registrationRequestHeaders,
  roleIdByKey,
  waitForEmail,
  type E2e,
  type TestClient,
} from '../index.js';
import { ErrorBodySchema } from './support/identity.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const uniqueName = (prefix: string) => `${prefix} ${randomUUID()}`;

const newSuperAdmin = () => newStaff(e2e.app, 'iam-super', 'super-admin');
const newLimitedAdmin = () => newStaff(e2e.app, 'iam-limited', 'admin');

async function bareAdmin(prefix: string) {
  const account = await newPlayer(e2e.app, prefix);
  await db().update(user).set({ role: 'admin' }).where(eq(user.id, account.userId));
  return account;
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

async function errorOf(res: Response) {
  return ErrorBodySchema.parse(await bodyOf(res));
}

async function createRole(client: TestClient, name = uniqueName('iam role')) {
  const res = await client.post('/iam/roles', { name });
  expect(res.status).toBe(200);
  return AdminRoleSchema.parse(await bodyOf(res));
}

type Grant = { resource: string; level: 'no_access' | 'read' | 'read_write' };

function putGrants(client: TestClient, roleId: string, grants: Grant[]) {
  return client.put(`/iam/roles/${roleId}/permissions`, { grants });
}

async function roleWith(client: TestClient, grants: Grant[]) {
  const role = await createRole(client);
  const res = await putGrants(client, role.id, grants);
  expect(res.status).toBe(200);
  return role;
}

async function storedGrants(roleId: string) {
  const rows = await db()
    .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
    .from(adminRolePermission)
    .where(eq(adminRolePermission.roleId, roleId));
  return rows.sort((a, b) => a.resource.localeCompare(b.resource));
}

async function assignedRoleIds(userId: string) {
  const rows = await db()
    .select({ roleId: adminRoleAssignment.roleId })
    .from(adminRoleAssignment)
    .where(eq(adminRoleAssignment.userId, userId));
  return rows.map((row) => row.roleId);
}

function assignViaApi(client: TestClient, userId: string, roleId: string) {
  return client.post('/iam/assignments', { userId, roleId });
}

function unassignViaApi(client: TestClient, userId: string, roleId: string) {
  return client.request('/iam/assignments', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, roleId }),
  });
}

async function holderOf(grants: Grant[]) {
  const creator = await newSuperAdmin();
  const role = await roleWith(creator.client, grants);
  const holder = await bareAdmin('iam-holder');
  const res = await assignViaApi(creator.client, holder.userId, role.id);
  expect(res.status).toBe(200);
  return { creator, role, holder };
}

async function waitForAudit(action: string, actorId: string, resourceId?: string) {
  return vi.waitFor(
    async () => {
      await flushAudit(e2e.app);
      const rows = await db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, action),
            eq(auditLog.actorId, actorId),
            ...(resourceId === undefined ? [] : [eq(auditLog.resourceId, resourceId)]),
          ),
        );
      if (rows.length === 0) {
        throw new Error(`no ${action} audit row for ${actorId} yet`);
      }
      return rows;
    },
    { timeout: 10_000, interval: 100 },
  );
}

async function superAdminHolderIds() {
  const rows = await db()
    .select({ userId: adminRoleAssignment.userId })
    .from(adminRoleAssignment)
    .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
    .where(eq(adminRole.isSuperAdmin, true));
  return rows.map((row) => row.userId);
}

async function withOnlySuperAdmins(keep: string[], run: () => Promise<void>) {
  const others = (await superAdminHolderIds()).filter((id) => !keep.includes(id));
  const deactivated =
    others.length === 0
      ? []
      : (
          await db()
            .select({ id: user.id })
            .from(user)
            .where(and(inArray(user.id, others), eq(user.isActive, true)))
        ).map((row) => row.id);
  if (deactivated.length > 0) {
    await db().update(user).set({ isActive: false }).where(inArray(user.id, deactivated));
  }
  try {
    await run();
  } finally {
    if (deactivated.length > 0) {
      await db().update(user).set({ isActive: true }).where(inArray(user.id, deactivated));
    }
  }
}

const READ_ROUTE = '/audit/logs';
const WRITE_ROUTE = '/audit/export';
const OTHER_MODULE_ROUTE = '/backoffice/stats';

describe('role management', () => {
  it('a super admin creates a role with per module levels and the role is listed', async () => {
    const admin = await newSuperAdmin();
    const name = uniqueName('iam created');

    const role = await createRole(admin.client, name);
    const setRes = await putGrants(admin.client, role.id, [
      { resource: 'player', level: 'read_write' },
      { resource: 'transaction', level: 'read' },
      { resource: 'game', level: 'no_access' },
    ]);

    expect(setRes.status).toBe(200);
    expect(AdminRoleWithGrantsSchema.parse(await bodyOf(setRes)).permissions).toEqual(
      expect.arrayContaining([
        { resource: 'player', level: 'read_write' },
        { resource: 'transaction', level: 'read' },
      ]),
    );
    expect(await storedGrants(role.id)).toEqual([
      { resource: 'player', level: 'read_write' },
      { resource: 'transaction', level: 'read' },
    ]);
    const listed = await admin.client.get('/iam/roles?limit=100&sortBy=createdAt&sortOrder=desc');
    expect(listed.status).toBe(200);
    const page = z
      .object({ items: z.array(AdminRoleWithGrantsSchema) })
      .parse(await bodyOf(listed));
    const entry = page.items.find((item) => item.id === role.id);
    expect(entry).toMatchObject({ name, isSystem: false, isSuperAdmin: false, key: null });
    expect(entry?.permissions).toHaveLength(2);
    const [created] = await waitForAudit('iam.role.created', admin.userId, role.id);
    expect(created).toMatchObject({ actorType: 'admin', resourceType: 'role' });
  });

  it.todo(
    'GAP: a role name that already exists is refused with a conflict (only the role key is unique at iam/schema/index.ts:35, createRole at iam.service.ts:417 inserts the name unchecked)',
  );

  it('a super admin updates the permissions of a role and the change is audited', async () => {
    const admin = await newSuperAdmin();
    const role = await roleWith(admin.client, [{ resource: 'audit', level: 'read' }]);

    const res = await putGrants(admin.client, role.id, [
      { resource: 'audit', level: 'read_write' },
      { resource: 'report', level: 'read' },
    ]);

    expect(res.status).toBe(200);
    expect(await storedGrants(role.id)).toEqual([
      { resource: 'audit', level: 'read_write' },
      { resource: 'report', level: 'read' },
    ]);
    await vi.waitFor(async () => {
      const rows = await waitForAudit('iam.role.permissions.changed', admin.userId, role.id);
      expect(rows.map((row) => ({ before: row.before, after: row.after }))).toContainEqual({
        before: [{ resource: 'audit', level: 'read' }],
        after: expect.arrayContaining([
          { resource: 'audit', level: 'read_write' },
          { resource: 'report', level: 'read' },
        ]),
      });
    });
  });

  it.todo(
    'GAP: a permission change on a role binds its holders on their very next request (iam/plugin.ts:78-86 purges the grant cache from an event handler, so the 10s TTL at iam.service.ts:184 is the floor; the next test covers the window)',
  );

  it('a permission change on a role binds its holders within the grant cache window', async () => {
    const { creator, role, holder } = await holderOf([{ resource: 'audit', level: 'read' }]);
    expect((await holder.client.get(READ_ROUTE)).status).toBe(200);
    expect((await holder.client.get(WRITE_ROUTE)).status).toBe(403);
    const writeStatus = async () => (await holder.client.get(WRITE_ROUTE)).status;

    const raise = await putGrants(creator.client, role.id, [
      { resource: 'audit', level: 'read_write' },
    ]);

    expect(raise.status).toBe(200);
    await vi.waitFor(async () => expect(await writeStatus()).toBe(200), { timeout: 12_000 });
    const strip = await putGrants(creator.client, role.id, [{ resource: 'audit', level: 'read' }]);
    expect(strip.status).toBe(200);
    await vi.waitFor(async () => expect(await writeStatus()).toBe(403), { timeout: 12_000 });
    expect((await holder.client.get(READ_ROUTE)).status).toBe(200);
  });

  it('a protected role cannot be renamed, edited or deleted', async () => {
    const admin = await newSuperAdmin();
    const superRoleId = await roleIdByKey(e2e.app.container, 'super-admin');
    const systemRoleId = await roleIdByKey(e2e.app.container, 'admin');
    const superBefore = await storedGrants(superRoleId);

    const rename = await admin.client.patch(`/iam/roles/${superRoleId}`, {
      name: uniqueName('renamed'),
    });
    const edit = await putGrants(admin.client, superRoleId, [{ resource: 'audit', level: 'read' }]);
    const removeSuper = await admin.client.del(`/iam/roles/${superRoleId}`);
    const removeSystem = await admin.client.del(`/iam/roles/${systemRoleId}`);

    for (const res of [rename, edit, removeSuper, removeSystem]) {
      expect(res.status).toBe(409);
    }
    const [superRow] = await db().select().from(adminRole).where(eq(adminRole.id, superRoleId));
    expect(superRow).toMatchObject({ key: 'super-admin', name: 'Super Admin', isSuperAdmin: true });
    expect(await storedGrants(superRoleId)).toEqual(superBefore);
    const systemRows = await db().select().from(adminRole).where(eq(adminRole.id, systemRoleId));
    expect(systemRows).toHaveLength(1);
  });

  it('deleting a role that is assigned unassigns it from every holder', async () => {
    const { creator, role, holder } = await holderOf([{ resource: 'audit', level: 'read' }]);
    expect((await holder.client.get(READ_ROUTE)).status).toBe(200);

    const res = await creator.client.del(`/iam/roles/${role.id}`);

    expect(res.status).toBe(200);
    expect(await db().select().from(adminRole).where(eq(adminRole.id, role.id))).toEqual([]);
    expect(await assignedRoleIds(holder.userId)).toEqual([]);
    expect(await storedGrants(role.id)).toEqual([]);
    expect((await holder.client.get(READ_ROUTE)).status).toBe(403);
    const revoked = await waitForAudit('iam.role.revoked', creator.userId, role.id);
    expect(revoked.map((row) => row.after)).toContainEqual({ userId: holder.userId });
    await waitForAudit('iam.role.deleted', creator.userId, role.id);
  });

  it('a non super admin cannot create, update or delete a role', async () => {
    const owner = await newSuperAdmin();
    const name = uniqueName('guarded role');
    const role = await roleWith(owner.client, [{ resource: 'audit', level: 'read' }]);
    const limited = await newLimitedAdmin();
    const refusedName = uniqueName('refused role');

    const create = await limited.client.post('/iam/roles', { name: refusedName });
    const rename = await limited.client.patch(`/iam/roles/${role.id}`, { name });
    const edit = await putGrants(limited.client, role.id, [
      { resource: 'audit', level: 'read_write' },
    ]);
    const remove = await limited.client.del(`/iam/roles/${role.id}`);

    for (const res of [create, rename, edit, remove]) {
      expect(res.status).toBe(403);
      expect((await errorOf(res)).data).toMatchObject({ reason: 'permission_denied' });
    }
    expect(await db().select().from(adminRole).where(eq(adminRole.name, refusedName))).toEqual([]);
    const [stored] = await db().select().from(adminRole).where(eq(adminRole.id, role.id));
    expect(stored?.name).not.toBe(name);
    expect(await storedGrants(role.id)).toEqual([{ resource: 'audit', level: 'read' }]);
  });

  it('a non super admin cannot raise grants, promote anyone to super admin or invite into it', async () => {
    const owner = await newSuperAdmin();
    const target = await roleWith(owner.client, [{ resource: 'audit', level: 'read' }]);
    const superRoleId = await roleIdByKey(e2e.app.container, 'super-admin');
    const limited = await newLimitedAdmin();
    const outsider = await bareAdmin('iam-escalation-target');

    const raise = await putGrants(limited.client, target.id, [
      { resource: 'audit', level: 'read_write' },
    ]);
    const selfPromote = await assignViaApi(limited.client, limited.userId, superRoleId);
    const promoteOther = await assignViaApi(limited.client, outsider.userId, superRoleId);
    const inviteSuper = await limited.client.post('/iam/invitations', {
      email: `${randomUUID()}@e2e.test`,
      roleId: superRoleId,
    });

    for (const res of [raise, selfPromote, promoteOther, inviteSuper]) {
      expect(res.status).toBe(403);
    }
    expect(await storedGrants(target.id)).toEqual([{ resource: 'audit', level: 'read' }]);
    expect(await assignedRoleIds(limited.userId)).not.toContain(superRoleId);
    expect(await assignedRoleIds(outsider.userId)).toEqual([]);
    expect((await limited.client.post('/iam/roles', { name: uniqueName('x') })).status).toBe(403);
  });

  it('the admin module cannot be granted to a role even by a super admin', async () => {
    const owner = await newSuperAdmin();
    const role = await createRole(owner.client);

    const res = await putGrants(owner.client, role.id, [
      { resource: 'admin', level: 'read_write' },
    ]);

    expect(res.status).toBe(400);
    expect(await storedGrants(role.id)).toEqual([]);
  });
});

describe('role assignment', () => {
  it('assigning a role gives the admin its permissions on the next request', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const admin = await bareAdmin('iam-next-request');
    expect((await admin.client.get(READ_ROUTE)).status).toBe(403);

    const res = await assignViaApi(creator.client, admin.userId, role.id);

    expect(res.status).toBe(200);
    expect(AdminRoleAssignmentSchema.parse(await bodyOf(res))).toMatchObject({
      userId: admin.userId,
      roleId: role.id,
    });
    expect(await assignedRoleIds(admin.userId)).toEqual([role.id]);
    expect((await admin.client.get(READ_ROUTE)).status).toBe(200);
    const [assigned] = await waitForAudit('iam.role.assigned', creator.userId, role.id);
    expect(assigned).toMatchObject({ actorType: 'admin', after: { userId: admin.userId } });
  });

  it('an admin with two roles holds the union of both roles permissions', async () => {
    const creator = await newSuperAdmin();
    const auditRole = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const reportRole = await roleWith(creator.client, [{ resource: 'report', level: 'read' }]);
    const admin = await bareAdmin('iam-union');

    await assignViaApi(creator.client, admin.userId, auditRole.id);
    expect((await admin.client.get(OTHER_MODULE_ROUTE)).status).toBe(403);
    await assignViaApi(creator.client, admin.userId, reportRole.id);

    expect((await admin.client.get(READ_ROUTE)).status).toBe(200);
    expect((await admin.client.get(OTHER_MODULE_ROUTE)).status).toBe(200);
    expect((await admin.client.get(WRITE_ROUTE)).status).toBe(403);
    const mine = await admin.client.get('/iam/my-permissions');
    expect(EffectivePermissionsSchema.parse(await bodyOf(mine)).permissions).toEqual(
      expect.arrayContaining([
        { resource: 'audit', level: 'read' },
        { resource: 'report', level: 'read' },
      ]),
    );
  });

  it('removing one of two roles keeps only the permissions of the remaining one', async () => {
    const creator = await newSuperAdmin();
    const auditRole = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const reportRole = await roleWith(creator.client, [{ resource: 'report', level: 'read' }]);
    const admin = await bareAdmin('iam-remove-one');
    await assignViaApi(creator.client, admin.userId, auditRole.id);
    await assignViaApi(creator.client, admin.userId, reportRole.id);
    expect((await admin.client.get(READ_ROUTE)).status).toBe(200);
    expect((await admin.client.get(OTHER_MODULE_ROUTE)).status).toBe(200);

    const res = await unassignViaApi(creator.client, admin.userId, auditRole.id);

    expect(res.status).toBe(200);
    expect(await assignedRoleIds(admin.userId)).toEqual([reportRole.id]);
    expect((await admin.client.get(READ_ROUTE)).status).toBe(403);
    expect((await admin.client.get(OTHER_MODULE_ROUTE)).status).toBe(200);
    await waitForAudit('iam.role.revoked', creator.userId, auditRole.id);
  });

  it('assigning a role to a player account is refused as not an admin user', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const player = await newPlayer(e2e.app, 'iam-player-target');

    const res = await assignViaApi(creator.client, player.userId, role.id);

    expect(res.status).toBe(400);
    expect(await assignedRoleIds(player.userId)).toEqual([]);
    expect((await player.client.get(READ_ROUTE)).status).toBe(403);
  });

  it('assigning a role to an unknown user returns not found', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const unknownUserId = randomUUID();

    const res = await assignViaApi(creator.client, unknownUserId, role.id);

    expect(res.status).toBe(404);
    expect(await assignedRoleIds(unknownUserId)).toEqual([]);
  });

  it('the last active super admin cannot be unassigned', async () => {
    const first = await newSuperAdmin();
    const second = await newSuperAdmin();
    const superRoleId = await roleIdByKey(e2e.app.container, 'super-admin');

    await withOnlySuperAdmins([first.userId, second.userId], async () => {
      const removeSecond = await unassignViaApi(first.client, second.userId, superRoleId);
      expect(removeSecond.status).toBe(200);

      const removeLast = await unassignViaApi(first.client, first.userId, superRoleId);

      expect(removeLast.status).toBe(409);
      expect(await assignedRoleIds(first.userId)).toContain(superRoleId);
      expect((await first.client.get('/iam/roles')).status).toBe(200);
    });
  });

  it('two parallel unassignments of two super admins never leave zero super admins', async () => {
    const superRoleId = await roleIdByKey(e2e.app.container, 'super-admin');

    for (let round = 0; round < 4; round += 1) {
      const first = await newSuperAdmin();
      const second = await newSuperAdmin();
      await withOnlySuperAdmins([first.userId, second.userId], async () => {
        const [fromFirst, fromSecond] = await Promise.all([
          unassignViaApi(first.client, second.userId, superRoleId),
          unassignViaApi(second.client, first.userId, superRoleId),
        ]);

        const statuses = [fromFirst.status, fromSecond.status].sort();
        expect(statuses[0]).toBe(200);
        expect([403, 409]).toContain(statuses[1]);
        const remaining = (await superAdminHolderIds()).filter((id) =>
          [first.userId, second.userId].includes(id),
        );
        expect(remaining).toHaveLength(1);
      });
    }
  });

  it.todo(
    'GAP: a role change ends the sessions of the affected admin (iam.service.ts:287 changeGrants revokes only MCP tokens)',
  );

  it('a role change does not end the sessions of other admins', async () => {
    const creator = await newSuperAdmin();
    const { holder } = await holderOf([{ resource: 'audit', level: 'read' }]);
    const other = await roleWith(creator.client, [{ resource: 'report', level: 'read' }]);
    const target = await bareAdmin('iam-session-target');
    const stillIn = async () => (await holder.client.get(READ_ROUTE)).status;
    expect(await stillIn()).toBe(200);

    expect((await assignViaApi(creator.client, target.userId, other.id)).status).toBe(200);
    expect(await stillIn()).toBe(200);
    expect((await unassignViaApi(creator.client, target.userId, other.id)).status).toBe(200);
    expect(await stillIn()).toBe(200);
    expect((await creator.client.del(`/iam/roles/${other.id}`)).status).toBe(200);
    expect(await stillIn()).toBe(200);
  });
});

describe('forbidden admin routes', () => {
  it('an admin with no access to a module is refused with forbidden on that module routes', async () => {
    const { holder } = await holderOf([{ resource: 'audit', level: 'read' }]);
    const unassigned = await bareAdmin('iam-no-role');

    const otherModule = await holder.client.get(OTHER_MODULE_ROUTE);
    const withoutRole = await unassigned.client.get(READ_ROUTE);

    expect(otherModule.status).toBe(403);
    expect((await errorOf(otherModule)).data).toMatchObject({
      reason: 'permission_denied',
      resource: 'report',
      action: 'view',
    });
    expect(withoutRole.status).toBe(403);
    expect((await holder.client.get(READ_ROUTE)).status).toBe(200);
  });

  it('an admin with read level can read but a write route is refused', async () => {
    const { holder } = await holderOf([{ resource: 'audit', level: 'read' }]);

    const read = await holder.client.get(READ_ROUTE);
    const write = await holder.client.get(WRITE_ROUTE);

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect((await errorOf(write)).data).toMatchObject({
      reason: 'permission_denied',
      resource: 'audit',
      action: 'export',
    });
  });

  it('an admin with read write level can call the write route', async () => {
    const { holder } = await holderOf([{ resource: 'audit', level: 'read_write' }]);

    const read = await holder.client.get(READ_ROUTE);
    const write = await holder.client.get(WRITE_ROUTE);

    expect(read.status).toBe(200);
    expect(write.status).toBe(200);
  });

  it('a denied admin route reports the access denial to the audit log', async () => {
    const { holder } = await holderOf([{ resource: 'audit', level: 'read' }]);

    const res = await holder.client.get(WRITE_ROUTE);

    expect(res.status).toBe(403);
    const rows = await waitForAudit(
      'identity.user.unauthorized_access',
      holder.userId,
      'audit:export',
    );
    expect(rows[0]).toMatchObject({ actorType: 'admin', resourceType: 'audit', result: 'failure' });
  });

  it('effective permissions for a user reflect the stored levels', async () => {
    const { creator, role, holder } = await holderOf([
      { resource: 'player', level: 'read_write' },
      { resource: 'audit', level: 'read' },
      { resource: 'game', level: 'no_access' },
    ]);
    const expected = [
      { resource: 'audit', level: 'read' },
      { resource: 'player', level: 'read_write' },
    ];
    const sorted = (items: { resource: string; level: string }[]) =>
      [...items].sort((a, b) => a.resource.localeCompare(b.resource));

    const byUser = await creator.client.post('/iam/effective-permissions', {
      userId: holder.userId,
    });
    const byRole = await creator.client.post('/iam/effective-permissions', { roleIds: [role.id] });
    const mine = await holder.client.get('/iam/my-permissions');

    for (const res of [byUser, byRole, mine]) {
      expect(res.status).toBe(200);
      expect(sorted(EffectivePermissionsSchema.parse(await bodyOf(res)).permissions)).toEqual(
        expected,
      );
    }
    expect(await storedGrants(role.id)).toEqual(expected);
  });

  it('an anonymous caller is refused with unauthorized on every admin route', async () => {
    const roleName = uniqueName('anonymous role');
    const id = randomUUID();
    const anonymous = (method: string, path: string, body?: unknown) =>
      e2e.app.app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const calls = [
      anonymous('GET', '/iam/catalog'),
      anonymous('GET', '/iam/roles'),
      anonymous('GET', `/iam/roles/${id}`),
      anonymous('POST', '/iam/roles', { name: roleName }),
      anonymous('PATCH', `/iam/roles/${id}`, { name: roleName }),
      anonymous('DELETE', `/iam/roles/${id}`),
      anonymous('PUT', `/iam/roles/${id}/permissions`, { grants: [] }),
      anonymous('GET', '/iam/assignments'),
      anonymous('POST', '/iam/assignments', { userId: id, roleId: id }),
      anonymous('DELETE', '/iam/assignments', { userId: id, roleId: id }),
      anonymous('POST', '/iam/assignments/force-logout', { userId: id }),
      anonymous('POST', '/iam/effective-permissions', { roleIds: [] }),
      anonymous('GET', '/iam/invitations'),
      anonymous('POST', '/iam/invitations', { email: `${id}@e2e.test`, roleId: id }),
      anonymous('GET', '/iam/my-permissions'),
      anonymous('POST', '/iam/report-access-denied', { resource: 'audit', level: 'read' }),
      anonymous('GET', READ_ROUTE),
      anonymous('GET', OTHER_MODULE_ROUTE),
    ];

    const responses = await Promise.all(calls);

    expect(responses.map((res) => res.status)).toEqual(responses.map(() => 401));
    expect(await db().select().from(adminRole).where(eq(adminRole.name, roleName))).toEqual([]);
  });
});

describe('invitations', () => {
  const TOKEN_IN_MAIL = /token: ([0-9a-f-]{36})/;
  const PASSWORD = 'invited-admin-pass-1';

  async function invite(client: TestClient, email: string, roleId: string) {
    const res = await client.post('/iam/invitations', { email, roleId });
    expect(res.status).toBe(200);
    const invitation = AdminInvitationSchema.parse(await bodyOf(res));
    const mail = await waitForEmail(email, (candidate) => TOKEN_IN_MAIL.test(candidate.text));
    const token = TOKEN_IN_MAIL.exec(mail.text)?.[1];
    if (!token) {
      throw new Error('the invitation mail carries no token');
    }
    return { invitation, token, mail };
  }

  function accept(token: string, password = PASSWORD, name = 'Invited Admin') {
    return e2e.app.app.request('/iam/invitations/accept', {
      method: 'POST',
      headers: registrationRequestHeaders(),
      body: JSON.stringify({ token, name, password }),
    });
  }

  const inviteeEmail = () => `invitee-${randomUUID()}@e2e.test`;

  async function usersByEmail(email: string) {
    return db().select().from(user).where(eq(user.email, email));
  }

  async function invitationRow(id: string) {
    const [row] = await db().select().from(adminInvitation).where(eq(adminInvitation.id, id));
    return row;
  }

  it('a super admin invites an email into a role and the invitee receives a token email', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const email = inviteeEmail();

    const { invitation, token, mail } = await invite(creator.client, email, role.id);

    expect(invitation).toMatchObject({
      email,
      roleId: role.id,
      status: 'pending',
      acceptedAt: null,
    });
    expect(JSON.stringify(invitation)).not.toContain(token);
    expect(mail.subject).toBe('You have been invited as an administrator');
    const stored = await invitationRow(invitation.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.tokenHash).not.toBe(token);
    const [created] = await waitForAudit('iam.invitation.created', creator.userId, invitation.id);
    expect(created).toMatchObject({ actorType: 'admin', after: { email, roleId: role.id } });
  });

  it('a non super admin cannot invite anyone into a role', async () => {
    const owner = await newSuperAdmin();
    const role = await roleWith(owner.client, [{ resource: 'audit', level: 'read' }]);
    const limited = await newLimitedAdmin();
    const email = inviteeEmail();

    const res = await limited.client.post('/iam/invitations', { email, roleId: role.id });

    expect(res.status).toBe(403);
    expect(
      await db().select().from(adminInvitation).where(eq(adminInvitation.email, email)),
    ).toEqual([]);
  });

  it('accepting a valid invitation creates an admin account with the role', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const email = inviteeEmail();
    const { invitation, token } = await invite(creator.client, email, role.id);

    const res = await accept(token);

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true, email });
    const [account] = await usersByEmail(email);
    expect(account).toMatchObject({ role: 'admin', isActive: true, name: 'Invited Admin' });
    expect(await assignedRoleIds(account?.id ?? '')).toEqual([role.id]);
    expect((await invitationRow(invitation.id))?.status).toBe('accepted');
    const signedIn = await asPlayer(e2e.app.app, { email, password: PASSWORD });
    expect((await signedIn.get(READ_ROUTE)).status).toBe(200);
    expect((await signedIn.get(WRITE_ROUTE)).status).toBe(403);
    const [accepted] = await waitForAudit(
      'iam.invitation.accepted',
      account?.id ?? '',
      invitation.id,
    );
    expect(accepted).toMatchObject({ after: { email, roleId: role.id } });
  });

  it('an invitation token cannot be accepted twice', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const email = inviteeEmail();
    const { token } = await invite(creator.client, email, role.id);
    expect((await accept(token)).status).toBe(200);

    const second = await accept(token, 'another-admin-pass-2', 'Second Taker');

    expect(second.status).toBe(409);
    const accounts = await usersByEmail(email);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.name).toBe('Invited Admin');
    expect(await assignedRoleIds(accounts[0]?.id ?? '')).toEqual([role.id]);
  });

  it('an expired invitation token is refused', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const email = inviteeEmail();
    const { invitation, token } = await invite(creator.client, email, role.id);
    await db()
      .update(adminInvitation)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(adminInvitation.id, invitation.id));

    const res = await accept(token);

    expect(res.status).toBe(409);
    expect(await usersByEmail(email)).toEqual([]);
    expect((await invitationRow(invitation.id))?.status).toBe('pending');
  });

  it.todo(
    'GAP: inviting an email that already has an account is refused (iam.service.ts:818 inviteAdmin never looks the email up; only acceptInvitation fails)',
  );

  it('accepting an invitation for an email that already has an account creates no admin', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const victim = await newPlayer(e2e.app, 'iam-invited-existing');
    const { invitation, token } = await invite(creator.client, victim.email, role.id);

    const res = await accept(token);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).data).toMatchObject({ reason: 'email_taken' });
    const accounts = await usersByEmail(victim.email);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: victim.userId, role: 'player' });
    expect(await assignedRoleIds(victim.userId)).toEqual([]);
    expect((await invitationRow(invitation.id))?.status).toBe('pending');
  });

  it('accepting with a password shorter than 12 characters is refused', async () => {
    const creator = await newSuperAdmin();
    const role = await roleWith(creator.client, [{ resource: 'audit', level: 'read' }]);
    const email = inviteeEmail();
    const { invitation, token } = await invite(creator.client, email, role.id);

    const tooShort = await accept(token, 'x'.repeat(11));

    expect(tooShort.status).toBe(400);
    expect(await usersByEmail(email)).toEqual([]);
    expect((await invitationRow(invitation.id))?.status).toBe('pending');
    const exact = await accept(token, 'x'.repeat(12));
    expect(exact.status).toBe(200);
    expect(await usersByEmail(email)).toHaveLength(1);
  });
});

describe('two person approval', () => {
  it.todo(
    'GAP: a request that needs approval stays pending until a different admin approves it (no approval request exists; the request and approval permissions are declared but unused at contracts/schemas/iam.ts:49-54 and compliance/router/index.ts:386)',
  );
  it.todo(
    'GAP: the requesting admin cannot approve their own request (no approval request exists; the request and approval permissions are declared but unused at contracts/schemas/iam.ts:49-54 and compliance/router/index.ts:386)',
  );
  it.todo(
    'GAP: an admin without the approve permission cannot approve (no approval request exists; the request and approval permissions are declared but unused at contracts/schemas/iam.ts:49-54 and compliance/router/index.ts:386)',
  );
  it.todo(
    'GAP: a request approved twice applies once (no approval request exists; the request and approval permissions are declared but unused at contracts/schemas/iam.ts:49-54 and compliance/router/index.ts:386)',
  );
  it.todo(
    'GAP: a rejected request never applies and records the reason (no approval request exists; the request and approval permissions are declared but unused at contracts/schemas/iam.ts:49-54 and compliance/router/index.ts:386)',
  );
});
