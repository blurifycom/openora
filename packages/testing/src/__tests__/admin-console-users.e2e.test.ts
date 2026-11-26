import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { session, user } from '@openora/core/pam/schema/identity';
import { bootE2e, closeE2e, flushAudit, newPlayer, newStaff, type E2e } from '../index.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  isActive: z.boolean(),
  role: z.string(),
  assignedRoles: z.array(z.object({ roleId: z.string(), roleName: z.string() })),
});
const UserPageSchema = z.object({
  items: z.array(AdminUserSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});
const StatsSchema = z.object({ totalUsers: z.number(), activeUsers: z.number() });
const ErrorSchema = z.object({
  code: z.string(),
  status: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const ALLOWED_USER_KEYS = new Set([
  'id',
  'email',
  'name',
  'createdAt',
  'isActive',
  'role',
  'failedLoginAttempts',
  'lockoutUntil',
  'assignedRoles',
]);

const directoryAdmin = () => newStaff(e2e.app, 'console-admin', 'admin');
const superAdmin = () => newStaff(e2e.app, 'console-super', 'super-admin');

async function userRow(userId: string) {
  const [row] = await db().select().from(user).where(eq(user.id, userId));
  if (!row) {
    throw new Error(`no user ${userId}`);
  }
  return row;
}

describe('admin user directory', () => {
  it('an admin with the permission lists users with pagination and a staff filter', async () => {
    const admin = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-listed');

    const firstPage = UserPageSchema.parse(
      await (await admin.client.get('/backoffice/users?page=1&limit=2')).json(),
    );
    const secondPage = UserPageSchema.parse(
      await (await admin.client.get('/backoffice/users?page=2&limit=2')).json(),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.limit).toBe(2);
    expect(secondPage.page).toBe(2);
    const firstIds = firstPage.items.map((item) => item.id);
    expect(secondPage.items.map((item) => item.id).some((id) => firstIds.includes(id))).toBe(false);
    const [{ n = 0 } = {}] = await db().select({ n: count() }).from(user);
    expect(firstPage.total).toBe(Number(n));

    const staff = UserPageSchema.parse(
      await (await admin.client.get('/backoffice/users?staffOnly=true&limit=100')).json(),
    );
    const staffIds = staff.items.map((item) => item.id);
    expect(staffIds).toContain(admin.userId);
    expect(staffIds).not.toContain(player.userId);
    expect(staff.items.every((item) => item.role !== 'player')).toBe(true);
  });

  it('listing supports a search by email and returns no player secrets', async () => {
    const admin = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-search');

    const res = await admin.client.get(
      `/backoffice/users?search=${encodeURIComponent(player.email)}`,
    );
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const page = UserPageSchema.parse(raw);
    expect(page.items.map((item) => item.id)).toEqual([player.userId]);
    expect(page.total).toBe(1);
    const keys = Object.keys(page.items[0] ?? {});
    expect(keys.filter((key) => !ALLOWED_USER_KEYS.has(key))).toEqual([]);
    expect(JSON.stringify(raw)).not.toMatch(/password|secret|token/i);
  });

  it('fetching one user returns profile, role and status', async () => {
    const admin = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-one');

    const playerRes = await admin.client.get(`/backoffice/users/${player.userId}`);
    expect(playerRes.status).toBe(200);
    expect(AdminUserSchema.parse(await playerRes.json())).toMatchObject({
      id: player.userId,
      email: player.email,
      name: player.name,
      role: 'player',
      isActive: true,
      assignedRoles: [],
    });

    const staffRes = await admin.client.get(`/backoffice/users/${admin.userId}`);
    const staff = AdminUserSchema.parse(await staffRes.json());
    expect(staff.role).toBe('admin');
    expect(staff.assignedRoles.map((role) => role.roleName)).toEqual(['Admin']);
  });

  it('fetching an unknown user returns not found', async () => {
    const admin = await directoryAdmin();
    const res = await admin.client.get(`/backoffice/users/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await res.json()).code).toBe('NOT_FOUND');
  });

  it('an admin without the permission is refused with forbidden', async () => {
    const marketing = await newStaff(e2e.app, 'console-marketing', 'marketing-banners');
    const player = await newPlayer(e2e.app, 'console-hidden');

    const list = await marketing.client.get('/backoffice/users');
    const one = await marketing.client.get(`/backoffice/users/${player.userId}`);
    const update = await marketing.client.patch(`/backoffice/users/${player.userId}`, {
      isActive: false,
    });
    expect([list.status, one.status, update.status]).toEqual([403, 403, 403]);
    expect(await list.text()).not.toContain(player.email);
    expect((await userRow(player.userId)).isActive).toBe(true);
  });

  it('an anonymous caller is refused with unauthorized', async () => {
    const player = await newPlayer(e2e.app, 'console-anon');
    const list = await e2e.app.app.request('/backoffice/users');
    const one = await e2e.app.app.request(`/backoffice/users/${player.userId}`);
    const update = await e2e.app.app.request(`/backoffice/users/${player.userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect([list.status, one.status, update.status]).toEqual([401, 401, 401]);
    expect((await userRow(player.userId)).isActive).toBe(true);
  });
});

describe('admin user update', () => {
  it('an admin updates a user active flag and the change is audited', async () => {
    const admin = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-toggle');

    const off = await admin.client.patch(`/backoffice/users/${player.userId}`, {
      isActive: false,
    });
    expect(off.status).toBe(200);
    expect(AdminUserSchema.parse(await off.json()).isActive).toBe(false);
    expect((await userRow(player.userId)).isActive).toBe(false);

    const on = await admin.client.patch(`/backoffice/users/${player.userId}`, { isActive: true });
    expect(on.status).toBe(200);
    expect((await userRow(player.userId)).isActive).toBe(true);

    await flushAudit(e2e.app);
    const rows = await db().select().from(auditLog).where(eq(auditLog.resourceId, player.userId));
    const updates = rows.filter((row) => row.action === 'admin.user.updated');
    expect(updates).toHaveLength(2);
    expect(updates.every((row) => row.actorId === admin.userId)).toBe(true);
    expect(updates.map((row) => [row.before, row.after])).toEqual(
      expect.arrayContaining([
        [
          { isActive: true, role: 'player' },
          { isActive: false, role: 'player' },
        ],
        [
          { isActive: false, role: 'player' },
          { isActive: true, role: 'player' },
        ],
      ]),
    );
  });

  it('deactivating an admin ends their sessions', async () => {
    const root = await superAdmin();
    const target = await directoryAdmin();
    expect((await target.client.get('/profile')).status).toBe(200);

    const res = await root.client.patch(`/backoffice/users/${target.userId}`, {
      isActive: false,
    });
    expect(res.status).toBe(200);

    expect((await target.client.get('/profile')).status).toBe(401);
    const sessions = await db()
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.userId, target.userId));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => row.expiresAt.getTime() <= Date.now())).toBe(true);
  });

  it('an admin cannot deactivate or demote their own account', async () => {
    const root = await superAdmin();

    const deactivate = await root.client.patch(`/backoffice/users/${root.userId}`, {
      isActive: false,
    });
    expect(deactivate.status).toBe(409);
    expect(ErrorSchema.parse(await deactivate.json()).data?.reason).toBe('self_lockout');

    const demote = await root.client.patch(`/backoffice/users/${root.userId}`, { role: 'player' });
    expect(demote.status).toBe(409);
    const row = await userRow(root.userId);
    expect(row.isActive).toBe(true);
    expect(row.role).toBe('admin');
    expect((await root.client.get('/backoffice/users')).status).toBe(200);
  });

  it('an admin cannot edit a user above their own level', async () => {
    const admin = await directoryAdmin();
    const peer = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-level');

    const edit = await admin.client.patch(`/backoffice/users/${peer.userId}`, {
      isActive: false,
    });
    expect(edit.status).toBe(403);
    const promote = await admin.client.patch(`/backoffice/users/${player.userId}`, {
      role: 'admin',
    });
    expect(promote.status).toBe(403);

    expect((await userRow(peer.userId)).isActive).toBe(true);
    expect((await userRow(player.userId)).role).toBe('player');
    await flushAudit(e2e.app);
    const rows = await db().select().from(auditLog).where(eq(auditLog.resourceId, peer.userId));
    expect(rows.filter((row) => row.action === 'admin.user.updated')).toHaveLength(0);
  });

  it('updating with an invalid active value is refused', async () => {
    const admin = await directoryAdmin();
    const player = await newPlayer(e2e.app, 'console-invalid');

    const res = await admin.client.patch(`/backoffice/users/${player.userId}`, {
      isActive: 'banned',
    });
    expect(res.status).toBe(400);
    expect((await userRow(player.userId)).isActive).toBe(true);
  });
});

describe('platform stats', () => {
  it('the stats route returns counts that match the rows created by the test', async () => {
    const admin = await directoryAdmin();
    const read = async () =>
      StatsSchema.parse(await (await admin.client.get('/backoffice/stats')).json());

    const before = await read();
    const [{ n: rowsBefore = 0 } = {}] = await db().select({ n: count() }).from(user);
    expect(before.totalUsers).toBe(Number(rowsBefore));

    await newPlayer(e2e.app, 'console-stats-a');
    await newPlayer(e2e.app, 'console-stats-b');
    const after = await read();
    const [{ n: rowsAfter = 0 } = {}] = await db().select({ n: count() }).from(user);
    expect(after.totalUsers).toBe(before.totalUsers + 2);
    expect(after.totalUsers).toBe(Number(rowsAfter));
  });

  it('the stats route is refused for an admin without the permission', async () => {
    const support = await newStaff(e2e.app, 'console-support', 'customer-support-agent');
    const res = await support.client.get('/backoffice/stats');
    expect(res.status).toBe(403);
    expect(StatsSchema.safeParse(await res.json()).success).toBe(false);
  });
});
