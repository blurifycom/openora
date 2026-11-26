import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { newStaff, registerPlayer } from '../index.js';
import {
  PASSWORD,
  WRONG_PASSWORD,
  ErrorBodySchema,
  LockedDataSchema,
  LoginSuccessSchema,
  bootIdentityE2e,
  errorOf,
  expireLockout,
  failLogins,
  liveSessionCount,
  login,
  newCredentialPlayer,
  postJson,
  smsCapturePlugin,
  uniqueEmail,
  userRow,
  type IdentityE2e,
} from './support/identity.js';
import { smsCodesFor } from './support/test-sms-capture-plugin.js';

let e2e: IdentityE2e;

beforeAll(async () => {
  e2e = await bootIdentityE2e([smsCapturePlugin]);
}, 60_000);

afterAll(async () => {
  await e2e?.app.close();
  await e2e?.db.dispose();
});

const db = () => e2e.app.container.get(DRIZZLE).db;

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

const lockedUntilMs = (body: unknown) => {
  const data = LockedDataSchema.parse(errorOf(body).data);
  return new Date(data.lockoutUntil).getTime() - Date.now();
};

const MINUTE = 60_000;

describe('player login', () => {
  it('a verified player signs in with the correct credentials and receives a session', async () => {
    const player = await newCredentialPlayer(e2e, 'login-ok');

    const result = await login(e2e, player.email, player.password);

    expect(result.status).toBe(200);
    const body = LoginSuccessSchema.parse(result.body);
    expect(body.user).toMatchObject({ id: player.userId, email: player.email });
    expect(body.session.token.length).toBeGreaterThan(0);
    expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const me = await e2e.app.app.request('/identity/me', {
      headers: { cookie: cookieOf(result.res) },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: player.userId });
  });

  it('a wrong password and an unknown email return the same generic error text', async () => {
    const player = await newCredentialPlayer(e2e, 'login-generic');

    const wrongPassword = await login(e2e, player.email, WRONG_PASSWORD);
    const unknownEmail = await login(e2e, uniqueEmail('nobody'), WRONG_PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(errorOf(wrongPassword.body).message).toBe(errorOf(unknownEmail.body).message);
    expect(errorOf(wrongPassword.body).code).toBe(errorOf(unknownEmail.body).code);
    expect(errorOf(wrongPassword.body).data).toEqual(errorOf(unknownEmail.body).data);
  });

  it('a login with the wrong password reports the remaining attempts', async () => {
    const player = await newCredentialPlayer(e2e, 'login-remaining');

    const [first, second] = await failLogins(e2e, player.email, 2);

    expect(first?.status).toBe(401);
    expect(errorOf(first?.body).data).toMatchObject({ attemptsRemaining: 4, lockoutUntil: null });
    expect(errorOf(second?.body).data).toMatchObject({ attemptsRemaining: 3, lockoutUntil: null });
  });

  it('a suspended or closed player cannot sign in', async () => {
    const suspended = await newCredentialPlayer(e2e, 'login-suspended');
    const closed = await newCredentialPlayer(e2e, 'login-closed');
    for (const [account, status] of [
      [suspended, 'suspended'],
      [closed, 'closed'],
    ] as const) {
      const res = await e2e.admin.patch(`/players/${account.playerId}`, { status });
      expect(res.status).toBe(200);
    }

    for (const account of [suspended, closed]) {
      const result = await login(e2e, account.email, account.password);
      expect(result.status).toBe(403);
      expect(errorOf(result.body).data).toMatchObject({ code: expect.any(String) });
      expect(result.res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('a successful login clears the failed attempt counter', async () => {
    const player = await newCredentialPlayer(e2e, 'login-clear');
    await failLogins(e2e, player.email, 3);
    expect((await userRow(e2e, player.userId)).failedLoginAttempts).toBe(3);

    const ok = await login(e2e, player.email, player.password);

    expect(ok.status).toBe(200);
    expect((await userRow(e2e, player.userId)).failedLoginAttempts).toBe(0);
    const [next] = await failLogins(e2e, player.email, 1);
    expect(errorOf(next?.body).data).toMatchObject({ attemptsRemaining: 4 });
  });

  it.todo('a login records the device and country on the session');
});

describe('login lockout escalation', () => {
  it('the fifth consecutive wrong password locks the account for one minute and returns the lock expiry', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-first');

    const results = await failLogins(e2e, player.email, 5);

    for (const result of results.slice(0, 4)) {
      expect(result.status).toBe(401);
      expect(ErrorBodySchema.parse(result.body).data).not.toHaveProperty('code', 'ACCOUNT_LOCKED');
    }
    const fifth = results[4];
    expect(fifth?.status).toBe(401);
    const remaining = lockedUntilMs(fifth?.body);
    expect(remaining).toBeGreaterThan(MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(MINUTE);
    const row = await userRow(e2e, player.userId);
    expect(row.lockoutCount).toBe(1);
    expect(row.lockoutUntil?.toISOString()).toBe(
      LockedDataSchema.parse(errorOf(fifth?.body).data).lockoutUntil,
    );
  });

  it('a correct password during an active lockout is still refused with the locked error', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-correct');
    await failLogins(e2e, player.email, 5);
    const sessionsBefore = await liveSessionCount(e2e, player.userId);

    const result = await login(e2e, player.email, player.password);

    expect(result.status).toBe(401);
    expect(LockedDataSchema.parse(errorOf(result.body).data).code).toBe('ACCOUNT_LOCKED');
    expect(result.res.headers.getSetCookie()).toEqual([]);
    expect(await liveSessionCount(e2e, player.userId)).toBe(sessionsBefore);
  });

  it('after the one minute lock expires and five more failures the account locks for five minutes', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-second');
    await failLogins(e2e, player.email, 5);
    await expireLockout(e2e, player.userId);

    const results = await failLogins(e2e, player.email, 5);

    const remaining = lockedUntilMs(results[4]?.body);
    expect(remaining).toBeGreaterThan(5 * MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(5 * MINUTE);
    expect((await userRow(e2e, player.userId)).lockoutCount).toBe(2);
  });

  it('after the five minute lock expires and five more failures the account locks for fifteen minutes', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-third');
    await failLogins(e2e, player.email, 5);
    await expireLockout(e2e, player.userId);
    await failLogins(e2e, player.email, 5);
    await expireLockout(e2e, player.userId);

    const results = await failLogins(e2e, player.email, 5);

    const remaining = lockedUntilMs(results[4]?.body);
    expect(remaining).toBeGreaterThan(15 * MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(15 * MINUTE);
    expect((await userRow(e2e, player.userId)).lockoutCount).toBe(3);
  });

  it('further lockouts after the third stay at fifteen minutes', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-capped');
    for (let round = 0; round < 3; round++) {
      await failLogins(e2e, player.email, 5);
      await expireLockout(e2e, player.userId);
    }

    const results = await failLogins(e2e, player.email, 5);

    const remaining = lockedUntilMs(results[4]?.body);
    expect(remaining).toBeGreaterThan(15 * MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(15 * MINUTE);
    expect((await userRow(e2e, player.userId)).lockoutCount).toBe(4);
  });

  it('the lockout level resets after a day without failures', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-reset');
    await failLogins(e2e, player.email, 5);
    await expireLockout(e2e, player.userId);
    await failLogins(e2e, player.email, 5);
    expect((await userRow(e2e, player.userId)).lockoutCount).toBe(2);
    const dayAgo = new Date(Date.now() - 25 * 60 * MINUTE);
    await db()
      .update(user)
      .set({
        lockoutUntil: new Date(Date.now() - 1000),
        lastFailedLoginAt: dayAgo,
        lastLockoutAt: dayAgo,
      })
      .where(eq(user.id, player.userId));

    const results = await failLogins(e2e, player.email, 5);

    const remaining = lockedUntilMs(results[4]?.body);
    expect(remaining).toBeGreaterThan(MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(MINUTE);
    expect((await userRow(e2e, player.userId)).lockoutCount).toBe(1);
  });

  it('a locked account does not reveal whether the email exists', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-enum');
    const ghost = uniqueEmail('lock-ghost');

    const known = await failLogins(e2e, player.email, 6);
    const unknown = await failLogins(e2e, ghost, 6);

    for (let i = 0; i < 6; i++) {
      expect(unknown[i]?.status).toBe(known[i]?.status);
      const knownError = errorOf(known[i]?.body);
      const unknownError = errorOf(unknown[i]?.body);
      expect(unknownError.code).toBe(knownError.code);
      expect(unknownError.message).toBe(knownError.message);
      expect(Object.keys(unknownError.data ?? {}).sort()).toEqual(
        Object.keys(knownError.data ?? {}).sort(),
      );
      expect(unknownError.data?.['attemptsRemaining']).toBe(knownError.data?.['attemptsRemaining']);
    }
    expect(LockedDataSchema.parse(errorOf(unknown[4]?.body).data).code).toBe('ACCOUNT_LOCKED');
    expect(lockedUntilMs(unknown[5]?.body)).toBeLessThanOrEqual(MINUTE);
  });

  it.todo('the unlock route with a valid emailed code ends the lockout');
  it.todo('the unlock route with a wrong code leaves the lockout in place');

  it('two parallel wrong-password bursts on one account still lock it once at the first tier', async () => {
    const player = await newCredentialPlayer(e2e, 'lock-parallel');

    const bursts = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => login(e2e, player.email, WRONG_PASSWORD))),
      Promise.all(Array.from({ length: 5 }, () => login(e2e, player.email, WRONG_PASSWORD))),
    ]);

    for (const result of bursts.flat()) {
      expect([401, 429]).toContain(result.status);
    }
    const row = await userRow(e2e, player.userId);
    expect(row.lockoutCount).toBe(1);
    expect(row.lockoutUntil).not.toBeNull();
    const remaining = (row.lockoutUntil?.getTime() ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(MINUTE - 10_000);
    expect(remaining).toBeLessThanOrEqual(MINUTE);
    const locked = bursts
      .flat()
      .filter((result) => LockedDataSchema.safeParse(errorOf(result.body).data).success);
    expect(locked.length).toBeGreaterThanOrEqual(1);
    for (const result of locked) {
      expect(LockedDataSchema.parse(errorOf(result.body).data).lockoutUntil).toBe(
        row.lockoutUntil?.toISOString(),
      );
    }
  });
});

describe('phone login', () => {
  const phoneNumber = () => `+1555${randomInt(1_000_000, 9_999_999)}`;

  async function newPhonePlayer(verified = true) {
    const player = await newCredentialPlayer(e2e, 'phone');
    const phone = phoneNumber();
    await db()
      .update(user)
      .set({ phoneNumber: phone, phoneVerified: verified })
      .where(eq(user.id, player.userId));
    return { ...player, phone };
  }

  it('a player with a verified phone requests a code and signs in with it', async () => {
    const player = await newPhonePlayer();

    const requested = await postJson(e2e, '/identity/phone-login/request', { phone: player.phone });
    expect(requested.status).toBe(200);
    const [code] = smsCodesFor(player.phone);
    expect(code).toMatch(/^[0-9]{6}$/);
    const verified = await postJson(e2e, '/identity/phone-login/verify', {
      phone: player.phone,
      code,
    });

    expect(verified.status).toBe(200);
    const body = LoginSuccessSchema.parse(verified.body);
    expect(body.user.id).toBe(player.userId);
    const me = await e2e.app.app.request('/identity/me', {
      headers: { cookie: cookieOf(verified.res) },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: player.userId });
  });

  it.todo('a wrong phone code is refused and counts toward the lockout');

  it('a phone number that belongs to no player gets the same neutral response as a known one', async () => {
    const known = await newPhonePlayer();
    const unverified = await newPhonePlayer(false);
    const stranger = phoneNumber();

    const knownResult = await postJson(e2e, '/identity/phone-login/request', {
      phone: known.phone,
    });
    const unverifiedResult = await postJson(e2e, '/identity/phone-login/request', {
      phone: unverified.phone,
    });
    const strangerResult = await postJson(e2e, '/identity/phone-login/request', {
      phone: stranger,
    });

    for (const result of [knownResult, unverifiedResult, strangerResult]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        expiresAt: expect.any(String),
        resendAfter: expect.any(String),
      });
    }
    expect(smsCodesFor(known.phone)).toHaveLength(1);
    expect(smsCodesFor(unverified.phone)).toHaveLength(0);
    expect(smsCodesFor(stranger)).toHaveLength(0);
  });
});

describe('side separation', () => {
  const countSessionCookies = (res: Response) => res.headers.getSetCookie().length;

  it('a player credential cannot sign in through the admin sign-in and no admin session is created', async () => {
    const email = uniqueEmail('sep-player');
    const userId = await registerPlayer(e2e.app, { email });
    const sessionsBefore = await liveSessionCount(e2e, userId);

    const result = await login(e2e, email, PASSWORD, { audience: 'staff' });

    expect(result.status).toBe(403);
    expect(errorOf(result.body).data).toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    expect(countSessionCookies(result.res)).toBe(0);
    expect(await liveSessionCount(e2e, userId)).toBe(sessionsBefore);
  });

  it('an admin credential cannot sign in as a player and no player session is created', async () => {
    const staff = await newStaff(e2e.app, 'sep-staff', 'super-admin');
    const sessionsBefore = await liveSessionCount(e2e, staff.userId);

    const result = await login(e2e, staff.email, PASSWORD, { audience: 'player' });

    expect(result.status).toBe(403);
    expect(errorOf(result.body).data).toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    expect(countSessionCookies(result.res)).toBe(0);
    expect(await liveSessionCount(e2e, staff.userId)).toBe(sessionsBefore);
  });

  it('a player session is refused by every admin route with forbidden', async () => {
    const player = await newCredentialPlayer(e2e, 'sep-routes');
    const adminReads = [
      '/players',
      '/identity/sessions/all',
      '/iam/roles',
      '/audit/logs',
      '/wallet/auto-withdrawal-config',
    ];

    for (const path of adminReads) {
      const res = await player.client.get(path);
      expect(res.status, path).toBe(403);
    }
    const adminWrites = [
      ['/identity/unlock', { userId: player.userId }],
      ['/identity/admin/password-reset', { userId: player.userId }],
    ] as const;
    for (const [path, body] of adminWrites) {
      const res = await player.client.post(path, body);
      expect(res.status, path).toBe(403);
    }
  });
});
