import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { DRIZZLE, setErrorReporter } from '@openora/core/server';
import { adminTrustedDevice } from '@openora/core/pam/schema/identity';
import { closeE2e, secretFromTotpUri, totpCode } from '../index.js';
import {
  ErrorBodySchema,
  LockedDataSchema,
  LoginSuccessSchema,
  PASSWORD,
  newCredentialPlayer,
  postJson,
  type IdentityE2e,
  bootIdentityE2e,
} from './support/identity.js';
import {
  BackupCodesSchema,
  ChallengeSchema,
  EnableSchema,
  OTHER_USER_AGENT,
  StatusSchema,
  TrustedDevicesSchema,
  VerifySchema,
  call,
  challengedBrowser,
  enrolledPlayer,
  hasSession,
  loginBrowser,
  newBrowser,
  signInWithCode,
  switchToSmsMethod,
  twoFactorRow,
  verifyCode,
  wrongCode,
} from './support/two-factor.js';

const smsFailurePlugin = {
  id: 'testing-sms-failure',
  path: fileURLToPath(new URL('../test-sms-failure-plugin.ts', import.meta.url)),
};

let e2e: IdentityE2e;

beforeAll(async () => {
  e2e = await bootIdentityE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

describe('two factor enrolment', () => {
  it('a player enables two factor, verifies the first code and receives backup codes once', async () => {
    const account = await newCredentialPlayer(e2e, 'tfa-enrol');
    const browser = newBrowser();
    await loginBrowser(e2e, browser, account.email, account.password);

    const enable = await call(e2e, browser, 'POST', '/identity/2fa/enable', {
      password: account.password,
    });
    expect(enable.status).toBe(200);
    const enabled = EnableSchema.parse(enable.body);
    expect(enabled.backupCodes.length).toBeGreaterThan(0);

    const verified = await verifyCode(e2e, browser, totpCode(secretFromTotpUri(enabled.totpUri)));
    expect(verified.status).toBe(200);
    expect(VerifySchema.parse(verified.body).success).toBe(true);

    const status = await call(e2e, browser, 'GET', '/identity/2fa/status');
    expect(StatusSchema.parse(status.body).enabled).toBe(true);
    const again = await call(e2e, browser, 'POST', '/identity/2fa/enable', {
      password: account.password,
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).not.toContain(enabled.backupCodes[0]);
  });

  it('a wrong first code leaves two factor disabled', async () => {
    const account = await newCredentialPlayer(e2e, 'tfa-wrongfirst');
    const browser = newBrowser();
    await loginBrowser(e2e, browser, account.email, account.password);
    const enabled = EnableSchema.parse(
      (await call(e2e, browser, 'POST', '/identity/2fa/enable', { password: account.password }))
        .body,
    );

    const verified = await verifyCode(e2e, browser, wrongCode(secretFromTotpUri(enabled.totpUri)));

    expect(verified.status).toBeGreaterThanOrEqual(400);
    const status = await call(e2e, browser, 'GET', '/identity/2fa/status');
    expect(StatusSchema.parse(status.body).enabled).toBe(false);
    expect((await twoFactorRow(e2e, account.userId)).enabled).toBeFalsy();
    const fresh = newBrowser();
    const login = await loginBrowser(e2e, fresh, account.email, account.password);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
  });

  it('two factor status reports enabled after enrolment and the number of backup codes left', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-status');
    const browser = await signInWithCode(e2e, player);

    const status = await call(e2e, browser, 'GET', '/identity/2fa/status');

    expect(status.status).toBe(200);
    expect(StatusSchema.parse(status.body)).toEqual({
      enabled: true,
      method: 'app',
      backupCodesRemaining: player.backupCodes.length,
    });
  });

  it('disabling two factor requires a valid code and removes the trusted devices', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-disable');
    const browser = newBrowser();
    await loginBrowser(e2e, browser, player.email, player.password);
    await verifyCode(e2e, browser, totpCode(player.secret), { trustDevice: true });
    const before = TrustedDevicesSchema.parse(
      (await call(e2e, browser, 'GET', '/identity/admin-security/trusted-devices')).body,
    );
    expect(before).toHaveLength(1);

    const refused = await call(e2e, browser, 'POST', '/identity/2fa/disable', {
      password: player.password,
      code: wrongCode(player.secret),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(
      StatusSchema.parse((await call(e2e, browser, 'GET', '/identity/2fa/status')).body).enabled,
    ).toBe(true);

    const disabled = await call(e2e, browser, 'POST', '/identity/2fa/disable', {
      password: player.password,
      code: totpCode(player.secret),
    });
    expect(disabled.status).toBe(200);

    const rows = await db()
      .select({ revokedAt: adminTrustedDevice.revokedAt })
      .from(adminTrustedDevice)
      .where(eq(adminTrustedDevice.userId, player.userId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    const fresh = newBrowser();
    const login = await loginBrowser(e2e, fresh, player.email, player.password);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
  });

  it('an anonymous caller cannot enable two factor', async () => {
    const res = await postJson(e2e, '/identity/2fa/enable', { password: PASSWORD });

    expect(res.status).toBe(401);
  });
});

describe('two factor login', () => {
  it('a player with two factor signs in with password then a valid code and receives a session', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-login');
    const { browser, login } = await challengedBrowser(e2e, player);
    expect(ChallengeSchema.parse(login.body).twoFactorRedirect).toBe(true);

    const verified = await verifyCode(e2e, browser, totpCode(player.secret));

    expect(verified.status).toBe(200);
    expect(await hasSession(e2e, browser)).toBe(true);
  });

  it('a password alone does not produce a session when two factor is on', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-pwonly');
    const { browser, login } = await challengedBrowser(e2e, player);

    expect(login.status).toBe(200);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(false);
    expect(ChallengeSchema.parse(login.body).twoFactorRedirect).toBe(true);
    expect(await hasSession(e2e, browser)).toBe(false);
    const profile = await call(e2e, browser, 'GET', '/profile');
    expect(profile.status).toBe(401);
  });

  it('a wrong code is refused and counts toward the two factor lockout', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-wrong');
    const { browser } = await challengedBrowser(e2e, player);

    const first = await verifyCode(e2e, browser, wrongCode(player.secret));
    const second = await verifyCode(e2e, browser, wrongCode(player.secret));

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect((await twoFactorRow(e2e, player.userId)).failed).toBe(2);
    expect(await hasSession(e2e, browser)).toBe(false);
  });

  it('repeated wrong codes lock the two factor challenge and a later correct code is refused during the lock', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-lock');
    const { browser } = await challengedBrowser(e2e, player);
    let last = await verifyCode(e2e, browser, wrongCode(player.secret));
    for (let i = 0; i < 4; i++) {
      last = await verifyCode(e2e, browser, wrongCode(player.secret));
    }
    expect(LockedDataSchema.safeParse(ErrorBodySchema.parse(last.body).data).success).toBe(true);
    expect((await twoFactorRow(e2e, player.userId)).lockoutUntil?.getTime()).toBeGreaterThan(
      Date.now(),
    );

    const correct = await verifyCode(e2e, browser, totpCode(player.secret));

    expect(correct.status).toBeGreaterThanOrEqual(400);
    expect(await hasSession(e2e, browser)).toBe(false);
    const fresh = await challengedBrowser(e2e, player);
    const afterRelogin = await verifyCode(e2e, fresh.browser, totpCode(player.secret));
    expect(afterRelogin.status).toBeGreaterThanOrEqual(400);
    expect(await hasSession(e2e, fresh.browser)).toBe(false);
  });

  it('a code from a previous time step is refused', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-stale');
    const { browser } = await challengedBrowser(e2e, player);

    const stale = await verifyCode(e2e, browser, totpCode(player.secret, Date.now() - 90_000));

    expect(stale.status).toBe(401);
    expect(await hasSession(e2e, browser)).toBe(false);
  });

  it.todo('a code cannot be replayed after a successful login');
});

describe('backup codes', () => {
  it('a backup code signs the player in once and is then spent', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-backup');
    const { browser } = await challengedBrowser(e2e, player);

    const verified = await verifyCode(e2e, browser, player.backupCodes[0] ?? '', {
      method: 'backup_code',
    });

    expect(verified.status).toBe(200);
    expect(await hasSession(e2e, browser)).toBe(true);
    const status = StatusSchema.parse(
      (await call(e2e, browser, 'GET', '/identity/2fa/status')).body,
    );
    expect(status.backupCodesRemaining).toBe(player.backupCodes.length - 1);
  });

  it('a spent backup code is refused on reuse', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-backup-reuse');
    const spent = player.backupCodes[0] ?? '';
    const first = await challengedBrowser(e2e, player);
    expect((await verifyCode(e2e, first.browser, spent, { method: 'backup_code' })).status).toBe(
      200,
    );

    const second = await challengedBrowser(e2e, player);
    const reuse = await verifyCode(e2e, second.browser, spent, { method: 'backup_code' });

    expect(reuse.status).toBe(401);
    expect(await hasSession(e2e, second.browser)).toBe(false);
    const other = await verifyCode(e2e, second.browser, player.backupCodes[1] ?? '', {
      method: 'backup_code',
    });
    expect(other.status).toBe(200);
  });

  it('regenerating backup codes invalidates the old set and requires a valid code', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-regen');
    const browser = await signInWithCode(e2e, player);

    const refused = await call(e2e, browser, 'POST', '/identity/2fa/backup-codes/regenerate', {
      password: player.password,
      code: wrongCode(player.secret),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const stillOld = await challengedBrowser(e2e, player);
    const oldStillWorks = await verifyCode(e2e, stillOld.browser, player.backupCodes[2] ?? '', {
      method: 'backup_code',
    });
    expect(oldStillWorks.status).toBe(200);

    const regenerated = await call(e2e, browser, 'POST', '/identity/2fa/backup-codes/regenerate', {
      password: player.password,
      code: totpCode(player.secret),
    });
    expect(regenerated.status).toBe(200);
    const fresh = BackupCodesSchema.parse(regenerated.body).backupCodes;
    expect(fresh).toHaveLength(player.backupCodes.length);

    const oldSet = await challengedBrowser(e2e, player);
    const oldRefused = await verifyCode(e2e, oldSet.browser, player.backupCodes[3] ?? '', {
      method: 'backup_code',
    });
    expect(oldRefused.status).toBe(401);
    const newSet = await challengedBrowser(e2e, player);
    const newAccepted = await verifyCode(e2e, newSet.browser, fresh[0] ?? '', {
      method: 'backup_code',
    });
    expect(newAccepted.status).toBe(200);
  });

  it('two parallel logins with the same backup code let only one succeed', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-backup-race');
    const code = player.backupCodes[0] ?? '';
    const [a, b] = await Promise.all([
      challengedBrowser(e2e, player),
      challengedBrowser(e2e, player),
    ]);

    const results = await Promise.all([
      verifyCode(e2e, a.browser, code, { method: 'backup_code' }),
      verifyCode(e2e, b.browser, code, { method: 'backup_code' }),
    ]);

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    const sessions = await Promise.all([hasSession(e2e, a.browser), hasSession(e2e, b.browser)]);
    expect(sessions.filter(Boolean)).toHaveLength(1);
  });
});

describe('trusted devices', () => {
  async function trustedBrowser(player: Awaited<ReturnType<typeof enrolledPlayer>>) {
    const { browser } = await challengedBrowser(e2e, player);
    const verified = await verifyCode(e2e, browser, totpCode(player.secret), {
      trustDevice: true,
    });
    expect(VerifySchema.parse(verified.body).trustGranted).toBe(true);
    return browser;
  }

  async function relogin(
    player: Awaited<ReturnType<typeof enrolledPlayer>>,
    browser: ReturnType<typeof newBrowser>,
  ) {
    browser.jar.forEach((_value, name) => {
      if (!name.endsWith('trust_device')) {
        browser.jar.delete(name);
      }
    });
    return loginBrowser(e2e, browser, player.email, player.password);
  }

  it('a player who trusts a device skips the code on the next login from the same user agent', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-trust');
    const browser = await trustedBrowser(player);

    const login = await relogin(player, browser);

    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
    expect(await hasSession(e2e, browser)).toBe(true);
  });

  it('a login from a different user agent still asks for the code', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-trust-ua');
    const browser = await trustedBrowser(player);
    browser.userAgent = OTHER_USER_AGENT;

    const login = await relogin(player, browser);

    expect(ChallengeSchema.safeParse(login.body).success).toBe(true);
    expect(await hasSession(e2e, browser)).toBe(false);
  });

  it('a trusted device stops working after its expiry', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-trust-expiry');
    const browser = await trustedBrowser(player);
    await db()
      .update(adminTrustedDevice)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminTrustedDevice.userId, player.userId));

    const login = await relogin(player, browser);

    expect(ChallengeSchema.safeParse(login.body).success).toBe(true);
    expect(await hasSession(e2e, browser)).toBe(false);
  });

  it('revoking a trusted device makes the next login ask for the code again', async () => {
    const player = await enrolledPlayer(e2e, 'tfa-trust-revoke');
    const trusted = await trustedBrowser(player);
    const session = await signInWithCode(e2e, player, OTHER_USER_AGENT);
    const listed = TrustedDevicesSchema.parse(
      (await call(e2e, session, 'GET', '/identity/admin-security/trusted-devices')).body,
    );
    expect(listed).toHaveLength(1);

    const revoked = await call(
      e2e,
      session,
      'POST',
      '/identity/admin-security/trusted-devices/revoke',
      {
        id: listed[0]?.id,
      },
    );
    expect(revoked.status).toBe(200);

    const login = await relogin(player, trusted);
    expect(ChallengeSchema.safeParse(login.body).success).toBe(true);
    expect(await hasSession(e2e, trusted)).toBe(false);
  });

  it('a player cannot revoke a trusted device of another player', async () => {
    const owner = await enrolledPlayer(e2e, 'tfa-trust-owner');
    const ownerBrowser = await trustedBrowser(owner);
    const ownerDevices = TrustedDevicesSchema.parse(
      (await call(e2e, ownerBrowser, 'GET', '/identity/admin-security/trusted-devices')).body,
    );
    const attacker = await enrolledPlayer(e2e, 'tfa-trust-attacker');
    const attackerBrowser = await signInWithCode(e2e, attacker);

    const attempt = await call(
      e2e,
      attackerBrowser,
      'POST',
      '/identity/admin-security/trusted-devices/revoke',
      { id: ownerDevices[0]?.id },
    );
    const crossUser = await call(
      e2e,
      attackerBrowser,
      'POST',
      '/identity/admin-security/trusted-devices/revoke-for-user',
      { userId: owner.userId, id: ownerDevices[0]?.id },
    );

    expect(attempt.status).toBe(404);
    expect([401, 403]).toContain(crossUser.status);
    const login = await relogin(owner, ownerBrowser);
    expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
  });
});

describe('two factor delivery failure', () => {
  let failing: IdentityE2e;

  beforeAll(async () => {
    failing = await bootIdentityE2e([smsFailurePlugin]);
  }, 60_000);

  afterAll(() => closeE2e(failing));

  async function smsChallenge(prefix: string) {
    const player = await enrolledPlayer(failing, prefix);
    await switchToSmsMethod(failing, player.userId);
    const { browser, login } = await challengedBrowser(failing, player);
    expect(ChallengeSchema.parse(login.body).twoFactorRedirect).toBe(true);
    return { player, browser };
  }

  it('when the code cannot be delivered the login returns a delivery error and no session', async () => {
    const { browser } = await smsChallenge('tfa-deliver-fail');

    const send = await call(failing, browser, 'POST', '/identity/2fa/otp/send');

    expect(send.status).toBe(503);
    expect(ErrorBodySchema.parse(send.body).code).toBe('SERVICE_UNAVAILABLE');
    expect(await hasSession(failing, browser)).toBe(false);
  });

  it('a delivery failure does not count as a wrong code toward the lockout', async () => {
    const { player, browser } = await smsChallenge('tfa-deliver-count');

    for (let i = 0; i < 3; i++) {
      const send = await call(failing, browser, 'POST', '/identity/2fa/otp/send');
      expect(send.status).toBe(503);
    }

    const row = await twoFactorRow(failing, player.userId);
    expect(row.failed).toBe(0);
    expect(row.lockoutUntil).toBeNull();
  });

  it('a delivery failure is reported to operations without exposing the provider error to the player', async () => {
    const { browser } = await smsChallenge('tfa-deliver-report');
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    try {
      const send = await call(failing, browser, 'POST', '/identity/2fa/otp/send');

      expect(send.status).toBe(503);
      expect(JSON.stringify(send.body)).not.toContain('vendor rejected');
      expect(JSON.stringify(send.body)).not.toContain('invalid sender id');
      expect(
        reported.some((error) => error instanceof Error && /vendor rejected/.test(error.message)),
      ).toBe(true);
    } finally {
      setErrorReporter(undefined);
    }
  });
});
