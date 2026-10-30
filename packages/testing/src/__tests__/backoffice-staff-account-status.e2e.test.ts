import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import {
  asAdmin,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let superAdmin: TestClient;
let superAdminId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

// A staff account holding one seeded role, signed in.
async function staffWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `staff-${roleKey}-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle().insert(adminRoleAssignment).values({ userId, roleId: role.id });
  return { client, userId };
}

const setActive = (client: TestClient, userId: string, isActive: boolean) =>
  client.patch(`/backoffice/users/${userId}`, { isActive });

const isActiveOf = async (userId: string) =>
  (await drizzle().select({ isActive: user.isActive }).from(user).where(eq(user.id, userId)))[0]
    ?.isActive;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  superAdmin = await asAdmin(app.app);
  const [row] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  superAdminId = row?.id ?? '';
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('PATCH /backoffice/users/{userId} on a staff account', () => {
  it('refuses a player editor disabling a super-admin', async () => {
    const { client: editor } = await staffWithRole('admin');

    const res = await setActive(editor, superAdminId, false);

    expect(res.status).toBe(403);
    expect(await isActiveOf(superAdminId)).toBe(true);
  });

  it('refuses a player editor disabling or re-enabling another staff account', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: colleague } = await staffWithRole('customer-support-agent');

    expect((await setActive(editor, colleague, false)).status).toBe(403);
    await drizzle().update(user).set({ isActive: false }).where(eq(user.id, colleague));
    expect((await setActive(editor, colleague, true)).status).toBe(403);
    expect(await isActiveOf(colleague)).toBe(false);
  });

  it('still lets a player editor disable a player', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: playerId } = await registerAndMaterializePlayer(app, {
      email: `player-${randomUUID()}@example.test`,
    });

    const res = await setActive(editor, playerId, false);

    expect(res.status).toBe(200);
    expect(await isActiveOf(playerId)).toBe(false);
  });

  it('refuses a super-admin disabling or demoting their own account, with a readable conflict', async () => {
    const disable = await setActive(superAdmin, superAdminId, false);
    const demote = await superAdmin.patch(`/backoffice/users/${superAdminId}`, { role: 'player' });

    for (const res of [disable, demote]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        message: 'You cannot disable your own account or change your own role',
        data: { reason: 'self_lockout' },
      });
    }
    const [self] = await drizzle()
      .select({ isActive: user.isActive, role: user.role })
      .from(user)
      .where(eq(user.id, superAdminId));
    expect(self).toEqual({ isActive: true, role: 'admin' });
  });

  it('lets a super-admin disable another super-admin while they stay active themselves', async () => {
    const { userId: otherSuper } = await staffWithRole('super-admin');

    expect((await setActive(superAdmin, otherSuper, false)).status).toBe(200);
    expect(await isActiveOf(otherSuper)).toBe(false);
  });

  it('lets exactly one of two super-admins disabling each other at once win', async () => {
    const one = await staffWithRole('super-admin');
    const two = await staffWithRole('super-admin');
    // Make these two the only active super-admins for the duration of the race.
    const others = (
      await drizzle()
        .select({ userId: adminRoleAssignment.userId, isActive: user.isActive })
        .from(adminRoleAssignment)
        .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
        .innerJoin(user, eq(user.id, adminRoleAssignment.userId))
        .where(eq(adminRole.isSuperAdmin, true))
    ).filter((h) => h.userId !== one.userId && h.userId !== two.userId && h.isActive);
    const setActiveDirect = (ids: string[], isActive: boolean) =>
      Promise.all(ids.map((id) => drizzle().update(user).set({ isActive }).where(eq(user.id, id))));
    await setActiveDirect(
      others.map((o) => o.userId),
      false,
    );
    try {
      const results = await Promise.all([
        setActive(one.client, two.userId, false),
        setActive(two.client, one.userId, false),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409);
      expect(await refused?.json()).toMatchObject({
        data: { reason: 'last_active_super_admin' },
      });
      const active = [await isActiveOf(one.userId), await isActiveOf(two.userId)];
      expect(active.filter(Boolean)).toHaveLength(1);
    } finally {
      await setActiveDirect(
        others.map((o) => o.userId),
        true,
      );
    }
  });

  it('lets a super-admin disable and re-enable a staff account, auditing each change', async () => {
    const { userId: staffId } = await staffWithRole('customer-support-agent');

    expect((await setActive(superAdmin, staffId, false)).status).toBe(200);
    expect(await isActiveOf(staffId)).toBe(false);
    expect((await setActive(superAdmin, staffId, true)).status).toBe(200);
    expect(await isActiveOf(staffId)).toBe(true);

    await vi.waitFor(async () => {
      const rows = await drizzle()
        .select({ actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'admin.user.updated'), eq(auditLog.resourceId, staffId)));
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            actorId: superAdminId,
            before: { isActive: true, role: 'admin' },
            after: { isActive: false, role: 'admin' },
          },
          {
            actorId: superAdminId,
            before: { isActive: false, role: 'admin' },
            after: { isActive: true, role: 'admin' },
          },
        ]),
      );
    });
  });
});
