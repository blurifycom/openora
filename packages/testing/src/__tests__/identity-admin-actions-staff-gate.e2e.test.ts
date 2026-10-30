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

const UNLOCK = '/identity/unlock';
const PASSWORD_RESET = '/identity/admin/password-reset';
const LOCKED_UNTIL = new Date(Date.now() + 60 * 60 * 1000);

const drizzle = () => app.container.get(DRIZZLE).db;

async function staffWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `gate-${roleKey}-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle().insert(adminRoleAssignment).values({ userId, roleId: role.id });
  return { client, userId };
}

const lockOut = (userId: string) =>
  drizzle()
    .update(user)
    .set({ failedLoginAttempts: 5, lockoutUntil: LOCKED_UNTIL })
    .where(eq(user.id, userId));

const lockoutOf = async (userId: string) =>
  (
    await drizzle()
      .select({ lockoutUntil: user.lockoutUntil })
      .from(user)
      .where(eq(user.id, userId))
  )[0]?.lockoutUntil;

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

describe('POST /identity/unlock', () => {
  it('refuses a player editor unlocking a super-admin, leaving the lockout in place', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: senior } = await staffWithRole('super-admin');
    await lockOut(senior);

    const res = await editor.post(UNLOCK, { userId: senior });

    expect(res.status).toBe(403);
    expect(await lockoutOf(senior)).toEqual(LOCKED_UNTIL);
  });

  it('refuses a player editor unlocking another staff account', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: colleague } = await staffWithRole('customer-support-agent');
    await lockOut(colleague);

    expect((await editor.post(UNLOCK, { userId: colleague })).status).toBe(403);
    expect(await lockoutOf(colleague)).toEqual(LOCKED_UNTIL);
  });

  it('lets a player editor unlock a player', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: playerId } = await registerAndMaterializePlayer(app, {
      email: `gate-player-${randomUUID()}@example.test`,
    });
    await lockOut(playerId);

    expect((await editor.post(UNLOCK, { userId: playerId })).status).toBe(200);
    expect(await lockoutOf(playerId)).toBeNull();
  });

  it('lets a super-admin unlock a staff account and audits it', async () => {
    const { userId: staffId } = await staffWithRole('customer-support-agent');
    await lockOut(staffId);

    expect((await superAdmin.post(UNLOCK, { userId: staffId })).status).toBe(200);
    expect(await lockoutOf(staffId)).toBeNull();
    await vi.waitFor(async () => {
      const rows = await drizzle()
        .select({ actorId: auditLog.actorId })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'identity.user.unlocked'), eq(auditLog.resourceId, staffId)),
        );
      expect(rows).toEqual([{ actorId: superAdminId }]);
    });
  });
});

describe('POST /identity/admin/password-reset', () => {
  it('refuses a player editor triggering a reset on a super-admin or another staff account', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: colleague } = await staffWithRole('customer-support-agent');

    expect((await editor.post(PASSWORD_RESET, { userId: superAdminId })).status).toBe(403);
    expect((await editor.post(PASSWORD_RESET, { userId: colleague })).status).toBe(403);
  });

  it('lets a player editor trigger a reset for a player', async () => {
    const { client: editor } = await staffWithRole('support-manager');
    const { userId: playerId } = await registerAndMaterializePlayer(app, {
      email: `gate-reset-${randomUUID()}@example.test`,
    });

    expect((await editor.post(PASSWORD_RESET, { userId: playerId })).status).toBe(200);
  });

  it('lets a super-admin trigger a reset for a staff account', async () => {
    const { userId: staffId } = await staffWithRole('customer-support-agent');

    expect((await superAdmin.post(PASSWORD_RESET, { userId: staffId })).status).toBe(200);
  });

  it('answers NOT_FOUND for an unknown user rather than leaking the gate', async () => {
    expect((await superAdmin.post(PASSWORD_RESET, { userId: randomUUID() })).status).toBe(404);
  });
});
