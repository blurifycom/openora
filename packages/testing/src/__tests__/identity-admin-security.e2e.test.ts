import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { adminTrustedDevice, session, twoFactor } from '@openora/core/pam/schema/identity';
import { player as playerTable } from '@openora/core/pam/schema/profile';
import { assignIamRoleByKey, closeE2e, flushAudit, secretFromTotpUri, totpCode } from '../index.js';
import {
  ErrorBodySchema,
  LoginSuccessSchema,
  bootIdentityE2e,
  newCredentialPlayer,
  type IdentityE2e,
} from './support/identity.js';
import {
  ChallengeSchema,
  EnableSchema,
  OTHER_USER_AGENT,
  TrustedDevicesSchema,
  VerifySchema,
  call,
  challengedBrowser,
  enrolledPlayer,
  hasSession,
  loginBrowser,
  newBrowser,
  signInWithCode,
  twoFactorRow,
  verifyCode,
  type Browser,
  type EnrolledPlayer,
} from './support/two-factor.js';

const adminSecurityPlugin = {
  id: 'testing-admin-security',
  path: fileURLToPath(new URL('../test-admin-security-plugin.ts', import.meta.url)),
};

let e2e: IdentityE2e;

beforeAll(async () => {
  e2e = await bootIdentityE2e([adminSecurityPlugin]);
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const REASON = 'lost authenticator device reported by the owner';

const StatusSchema = z.object({
  twoFactorEnabled: z.boolean(),
  enrollmentRequired: z.boolean(),
});
const SessionsMeSchema = z.object({
  items: z.array(z.object({ id: z.string(), current: z.boolean() })),
});
const SessionsPageSchema = z.object({
  items: z.array(z.object({ id: z.string(), userId: z.string(), email: z.string() })),
});

async function enrolledStaff(prefix: string, roleKey: string) {
  const staff = await enrolledPlayer(e2e, prefix);
  await assignIamRoleByKey(e2e.app.container, staff.userId, roleKey);
  return staff;
}

async function unenrolledStaff(prefix: string, roleKey: string) {
  const account = await newCredentialPlayer(e2e, prefix);
  await assignIamRoleByKey(e2e.app.container, account.userId, roleKey);
  return account;
}

async function enrollInPlace(browser: Browser, password: string) {
  const enable = await call(e2e, browser, 'POST', '/identity/2fa/enable', { password });
  expect(enable.status).toBe(200);
  const secret = secretFromTotpUri(EnableSchema.parse(enable.body).totpUri);
  const verified = await verifyCode(e2e, browser, totpCode(secret));
  expect(VerifySchema.parse(verified.body).success).toBe(true);
  return secret;
}

async function trustedStaffBrowser(staff: EnrolledPlayer, userAgent?: string) {
  const { browser } = await challengedBrowser(e2e, staff, userAgent);
  const verified = await verifyCode(e2e, browser, totpCode(staff.secret), { trustDevice: true });
  expect(VerifySchema.parse(verified.body).trustGranted).toBe(true);
  return browser;
}

async function relogin(staff: EnrolledPlayer, browser: Browser) {
  browser.jar.forEach((_value, name) => {
    if (!name.endsWith('trust_device')) {
      browser.jar.delete(name);
    }
  });
  return loginBrowser(e2e, browser, staff.email, staff.password);
}

async function playerIdOf(userId: string) {
  const [row] = await db()
    .select({ id: playerTable.id })
    .from(playerTable)
    .where(eq(playerTable.userId, userId));
  if (!row) {
    throw new Error(`no player for ${userId}`);
  }
  return row.id;
}

async function trustedDeviceRows(userId: string) {
  return db()
    .select()
    .from(adminTrustedDevice)
    .where(and(eq(adminTrustedDevice.userId, userId), isNull(adminTrustedDevice.revokedAt)));
}

async function liveSessionIds(userId: string) {
  const rows = await db().select().from(session).where(eq(session.userId, userId));
  return rows.filter((row) => row.expiresAt.getTime() > Date.now()).map((row) => row.id);
}

function reasonOf(body: unknown) {
  return ErrorBodySchema.parse(body).data?.['reason'];
}

describe('admin two factor is mandatory', () => {
  it('an admin without two factor can sign in only to the enrolment step and every other admin route is refused', async () => {
    const admin = await unenrolledStaff('adm-mandatory', 'super-admin');
    const browser = newBrowser();

    const login = await loginBrowser(e2e, browser, admin.email, admin.password);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);

    const status = await call(e2e, browser, 'GET', '/identity/admin-security/status');
    expect(status.status).toBe(200);
    expect(StatusSchema.parse(status.body)).toEqual({
      twoFactorEnabled: false,
      enrollmentRequired: true,
    });
    for (const path of ['/identity/sessions/all', '/players', '/iam/roles', '/audit/logs']) {
      const refused = await call(e2e, browser, 'GET', path);
      expect(refused.status, path).toBe(403);
      expect(reasonOf(refused.body), path).toBe('two_factor_required');
    }
    const superOnly = await call(e2e, browser, 'POST', '/identity/admin-security/2fa/reset', {
      userId: admin.userId,
      reason: REASON,
    });
    expect(superOnly.status).toBe(403);
    expect(reasonOf(superOnly.body)).toBe('two_factor_required');

    const enable = await call(e2e, browser, 'POST', '/identity/2fa/enable', {
      password: admin.password,
    });
    expect(enable.status).toBe(200);
  });

  it('an admin completes enrolment and reaches the admin routes', async () => {
    const admin = await unenrolledStaff('adm-enrol', 'super-admin');
    const browser = newBrowser();
    await loginBrowser(e2e, browser, admin.email, admin.password);
    const before = await call(e2e, browser, 'GET', '/identity/sessions/all');
    expect(before.status).toBe(403);

    await enrollInPlace(browser, admin.password);

    const after = await call(e2e, browser, 'GET', '/identity/sessions/all');
    expect(after.status).toBe(200);
    const status = await call(e2e, browser, 'GET', '/identity/admin-security/status');
    expect(StatusSchema.parse(status.body)).toEqual({
      twoFactorEnabled: true,
      enrollmentRequired: false,
    });
    expect((await twoFactorRow(e2e, admin.userId)).enabled).toBe(true);
  });

  it.todo('an admin cannot disable two factor while the policy is mandatory');

  it('an admin with two factor needs a code at every sign in from an untrusted device', async () => {
    const admin = await enrolledStaff('adm-code', 'super-admin');

    for (const userAgent of [undefined, OTHER_USER_AGENT]) {
      const { browser, login } = await challengedBrowser(e2e, admin, userAgent);
      expect(ChallengeSchema.safeParse(login.body).success).toBe(true);
      expect(await hasSession(e2e, browser)).toBe(false);
      const blocked = await call(e2e, browser, 'GET', '/identity/sessions/all');
      expect([401, 403]).toContain(blocked.status);

      const verified = await verifyCode(e2e, browser, totpCode(admin.secret));
      expect(VerifySchema.parse(verified.body).success).toBe(true);
      const allowed = await call(e2e, browser, 'GET', '/identity/sessions/all');
      expect(allowed.status).toBe(200);
    }
  });
});

describe('admin trusted devices', () => {
  it('an admin trusts the current device and skips the code on the next sign in', async () => {
    const admin = await enrolledStaff('adm-trust', 'super-admin');
    const browser = await signInWithCode(e2e, admin);
    expect(await trustedDeviceRows(admin.userId)).toHaveLength(0);

    const trusted = await call(
      e2e,
      browser,
      'POST',
      '/identity/admin-security/trusted-devices/trust',
      { password: admin.password, code: totpCode(admin.secret) },
    );
    expect(trusted.status).toBe(200);
    expect(await trustedDeviceRows(admin.userId)).toHaveLength(1);

    const login = await relogin(admin, browser);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
    expect((await call(e2e, browser, 'GET', '/identity/sessions/all')).status).toBe(200);
  });

  it('an admin lists and revokes a trusted device', async () => {
    const admin = await enrolledStaff('adm-devices', 'super-admin');
    const trusted = await trustedStaffBrowser(admin);

    const listed = TrustedDevicesSchema.parse(
      (await call(e2e, trusted, 'GET', '/identity/admin-security/trusted-devices')).body,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.isCurrent).toBe(true);

    const revoked = await call(
      e2e,
      trusted,
      'POST',
      '/identity/admin-security/trusted-devices/revoke',
      { id: listed[0]?.id },
    );
    expect(revoked.status).toBe(200);
    expect(await trustedDeviceRows(admin.userId)).toHaveLength(0);
    expect(
      TrustedDevicesSchema.parse(
        (await call(e2e, trusted, 'GET', '/identity/admin-security/trusted-devices')).body,
      ),
    ).toEqual([]);

    const login = await relogin(admin, trusted);
    expect(ChallengeSchema.safeParse(login.body).success).toBe(true);
    expect(await hasSession(e2e, trusted)).toBe(false);
  });

  it('a super admin revokes a trusted device of another admin', async () => {
    const owner = await enrolledStaff('adm-owner', 'admin');
    const laptop = await trustedStaffBrowser(owner);
    const phone = await trustedStaffBrowser(owner, OTHER_USER_AGENT);
    const devices = TrustedDevicesSchema.parse(
      (await call(e2e, laptop, 'GET', '/identity/admin-security/trusted-devices')).body,
    );
    const laptopDevice = devices.find((device) => device.isCurrent);
    expect(devices).toHaveLength(2);
    const superAdmin = await signInWithCode(e2e, await enrolledStaff('adm-super', 'super-admin'));

    const revoked = await call(
      e2e,
      superAdmin,
      'POST',
      '/identity/admin-security/trusted-devices/revoke-for-user',
      { userId: owner.userId, id: laptopDevice?.id },
    );

    expect(revoked.status).toBe(200);
    expect(await trustedDeviceRows(owner.userId)).toHaveLength(1);
    const laptopLogin = await relogin(owner, laptop);
    expect(ChallengeSchema.safeParse(laptopLogin.body).success).toBe(true);
    const phoneLogin = await relogin(owner, phone);
    expect(LoginSuccessSchema.safeParse(phoneLogin.body).success).toBe(true);
  });

  it('an admin without the permission cannot revoke trusted devices of another admin', async () => {
    const owner = await enrolledStaff('adm-owner2', 'admin');
    const trusted = await trustedStaffBrowser(owner);
    const devices = await trustedDeviceRows(owner.userId);
    const attacker = await signInWithCode(e2e, await enrolledStaff('adm-peer', 'admin'));

    const attempt = await call(
      e2e,
      attacker,
      'POST',
      '/identity/admin-security/trusted-devices/revoke-for-user',
      { userId: owner.userId, id: devices[0]?.id },
    );

    expect(attempt.status).toBe(403);
    expect(await trustedDeviceRows(owner.userId)).toHaveLength(1);
    const login = await relogin(owner, trusted);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
  });
});

describe('two factor reset', () => {
  it('a super admin resets the two factor of another admin and that admin must enrol again', async () => {
    const target = await enrolledStaff('adm-reset-target', 'admin');
    const targetBrowser = await signInWithCode(e2e, target);
    expect((await call(e2e, targetBrowser, 'GET', '/identity/sessions/all')).status).toBe(200);
    const superAdmin = await signInWithCode(
      e2e,
      await enrolledStaff('adm-reset-by', 'super-admin'),
    );

    const reset = await call(e2e, superAdmin, 'POST', '/identity/admin-security/2fa/reset', {
      userId: target.userId,
      reason: REASON,
    });

    expect(reset.status).toBe(200);
    expect((await twoFactorRow(e2e, target.userId)).enabled).toBe(false);
    expect(await db().select().from(twoFactor).where(eq(twoFactor.userId, target.userId))).toEqual(
      [],
    );
    expect(await hasSession(e2e, targetBrowser)).toBe(false);
    expect(await liveSessionIds(target.userId)).toEqual([]);

    const fresh = newBrowser();
    const login = await loginBrowser(e2e, fresh, target.email, target.password);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
    const blocked = await call(e2e, fresh, 'GET', '/identity/sessions/all');
    expect(blocked.status).toBe(403);
    expect(reasonOf(blocked.body)).toBe('two_factor_required');
    const status = await call(e2e, fresh, 'GET', '/identity/admin-security/status');
    expect(StatusSchema.parse(status.body).enrollmentRequired).toBe(true);
  });

  it('an admin resets the two factor of a player with the permission and the player sessions end', async () => {
    const player = await enrolledPlayer(e2e, 'adm-reset-player');
    const playerBrowser = await signInWithCode(e2e, player);
    expect(await hasSession(e2e, playerBrowser)).toBe(true);
    const staff = await signInWithCode(e2e, await enrolledStaff('adm-support', 'admin'));

    const reset = await call(e2e, staff, 'POST', '/identity/admin-security/2fa/reset-player', {
      userId: player.userId,
      reason: REASON,
    });

    expect(reset.status).toBe(200);
    expect((await twoFactorRow(e2e, player.userId)).enabled).toBe(false);
    expect(await db().select().from(twoFactor).where(eq(twoFactor.userId, player.userId))).toEqual(
      [],
    );
    expect(await hasSession(e2e, playerBrowser)).toBe(false);
    expect(await liveSessionIds(player.userId)).toEqual([]);
  });

  it('a reset without the permission is refused with forbidden', async () => {
    const target = await enrolledStaff('adm-reset-denied', 'admin');
    const player = await enrolledPlayer(e2e, 'adm-reset-denied-player');
    const junior = await signInWithCode(e2e, await enrolledStaff('adm-junior', 'casino-manager'));
    const peer = await signInWithCode(e2e, await enrolledStaff('adm-peer2', 'admin'));

    const playerReset = await call(
      e2e,
      junior,
      'POST',
      '/identity/admin-security/2fa/reset-player',
      {
        userId: player.userId,
        reason: REASON,
      },
    );
    const adminReset = await call(e2e, peer, 'POST', '/identity/admin-security/2fa/reset', {
      userId: target.userId,
      reason: REASON,
    });

    expect(playerReset.status).toBe(403);
    expect(reasonOf(playerReset.body)).toBe('permission_denied');
    expect(adminReset.status).toBe(403);
    expect(reasonOf(adminReset.body)).toBe('admin_required');
    expect((await twoFactorRow(e2e, player.userId)).enabled).toBe(true);
    expect((await twoFactorRow(e2e, target.userId)).enabled).toBe(true);
  });

  it('an admin cannot reset their own two factor through the admin reset route', async () => {
    const admin = await enrolledStaff('adm-self', 'super-admin');
    const browser = await signInWithCode(e2e, admin);

    const reset = await call(e2e, browser, 'POST', '/identity/admin-security/2fa/reset', {
      userId: admin.userId,
      reason: REASON,
    });

    expect(reset.status).toBe(409);
    expect((await twoFactorRow(e2e, admin.userId)).enabled).toBe(true);
    expect(await hasSession(e2e, browser)).toBe(true);
  });

  it('every reset is recorded in the audit log with actor and target', async () => {
    const target = await enrolledStaff('adm-audit-target', 'admin');
    const player = await enrolledPlayer(e2e, 'adm-audit-player');
    const actor = await enrolledStaff('adm-audit-actor', 'super-admin');
    const browser = await signInWithCode(e2e, actor);

    const adminReset = await call(e2e, browser, 'POST', '/identity/admin-security/2fa/reset', {
      userId: target.userId,
      reason: REASON,
    });
    const playerReset = await call(
      e2e,
      browser,
      'POST',
      '/identity/admin-security/2fa/reset-player',
      { userId: player.userId, reason: REASON },
    );
    expect(adminReset.status).toBe(200);
    expect(playerReset.status).toBe(200);
    await flushAudit(e2e.app);

    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, actor.userId), eq(auditLog.actorType, 'admin')));
    const resets = rows.filter((row) => /2fa\.reset/.test(row.action));
    expect(resets.map((row) => row.resourceId).sort()).toEqual(
      [await playerIdOf(target.userId), await playerIdOf(player.userId)].sort(),
    );
    for (const row of resets) {
      expect(JSON.stringify(row)).toContain(REASON);
    }
  });
});

describe('admin sessions', () => {
  it('an admin lists all admin sessions with the permission', async () => {
    const other = await enrolledStaff('adm-listed', 'admin');
    await signInWithCode(e2e, other);
    const viewer = await signInWithCode(e2e, await enrolledStaff('adm-viewer', 'admin'));

    const listed = await call(e2e, viewer, 'GET', '/identity/sessions/all?limit=100');

    expect(listed.status).toBe(200);
    const page = SessionsPageSchema.parse(listed.body);
    expect(page.items.some((item) => item.userId === other.userId)).toBe(true);
  });

  it('an admin without the permission cannot list all sessions', async () => {
    const other = await enrolledStaff('adm-listed2', 'admin');
    await signInWithCode(e2e, other);
    const viewer = await signInWithCode(e2e, await enrolledStaff('adm-noview', 'casino-manager'));

    const listed = await call(e2e, viewer, 'GET', '/identity/sessions/all?limit=100');

    expect(listed.status).toBe(403);
    expect(reasonOf(listed.body)).toBe('permission_denied');
    expect(JSON.stringify(listed.body)).not.toContain(other.email);
  });

  it('an admin force logs out another admin session', async () => {
    const target = await enrolledStaff('adm-forced', 'admin');
    const targetBrowser = await signInWithCode(e2e, target);
    const mine = SessionsMeSchema.parse(
      (await call(e2e, targetBrowser, 'GET', '/identity/sessions/me')).body,
    );
    const targetSession = mine.items.find((item) => item.current)?.id;
    expect(targetSession).toBeDefined();
    const actor = await signInWithCode(e2e, await enrolledStaff('adm-forcer', 'admin'));

    const revoked = await call(e2e, actor, 'POST', '/identity/sessions/revoke', {
      userId: target.userId,
      id: targetSession,
    });

    expect(revoked.status).toBe(200);
    expect(await liveSessionIds(target.userId)).not.toContain(targetSession);
    expect(await hasSession(e2e, targetBrowser)).toBe(false);
  });
});
