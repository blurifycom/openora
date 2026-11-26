import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { session, verification } from '@openora/core/pam/schema/identity';
import {
  asPlayer,
  capturedEmailsFor,
  flushAudit,
  newStaff,
  waitForEmail,
  type TestClient,
} from '../index.js';
import {
  PASSWORD,
  bootIdentityE2e,
  errorOf,
  liveSessionCount,
  login,
  newCredentialPlayer,
  postJson,
  uniqueEmail,
  type IdentityE2e,
} from './support/identity.js';

let e2e: IdentityE2e;

beforeAll(async () => {
  e2e = await bootIdentityE2e();
}, 60_000);

afterAll(async () => {
  await e2e?.app.close();
  await e2e?.db.dispose();
});

const db = () => e2e.app.container.get(DRIZZLE).db;

const NEW_PASSWORD = 'a-brand-new-passphrase';
const SUCCESS = { success: true };
const INVALID_CODE_MESSAGE = 'Invalid or expired verification code';

const isResetMail = (mail: { subject: string }) => /reset|password/i.test(mail.subject);

async function resetCodeFor(email: string) {
  const mail = await waitForEmail(email, isResetMail);
  const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
  if (!code) {
    throw new Error(`no reset code in mail for ${email}: ${mail.text}`);
  }
  return code;
}

async function requestReset(email: string) {
  const res = await postJson(e2e, '/identity/password/forgot', { email });
  expect(res.status).toBe(200);
  return resetCodeFor(email);
}

const reset = (email: string, otp: string, newPassword = NEW_PASSWORD) =>
  postJson(e2e, '/identity/password/reset', { email, otp, newPassword });

const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

async function signedInClients(email: string, count: number): Promise<TestClient[]> {
  return Promise.all(Array.from({ length: count }, () => asPlayer(e2e.app.app, { email })));
}

describe('password reset', () => {
  it('a player requests a reset and receives a code by email', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-request');

    const res = await postJson(e2e, '/identity/password/forgot', { email: player.email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    const mail = await waitForEmail(player.email, isResetMail);
    expect(mail.to.toLowerCase()).toBe(player.email.toLowerCase());
    expect(mail.text).toMatch(/\b\d{6}\b/);
  });

  it('forgot password for an unknown email returns the same neutral result and sends no email', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-neutral');
    const ghost = uniqueEmail('reset-ghost');

    const unknown = await postJson(e2e, '/identity/password/forgot', { email: ghost });
    const known = await postJson(e2e, '/identity/password/forgot', { email: player.email });
    await waitForEmail(player.email, isResetMail);

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body).toEqual(SUCCESS);
    expect(capturedEmailsFor(ghost)).toEqual([]);
  });

  it('a valid code lets the player set a new 12 character password and the old one stops working', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-valid');
    const code = await requestReset(player.email);

    const res = await reset(player.email, code);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    expect(NEW_PASSWORD.length).toBeGreaterThanOrEqual(12);
    expect((await login(e2e, player.email, PASSWORD)).status).toBe(401);
    expect((await login(e2e, player.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a new password shorter than 12 characters is refused', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-short');
    const code = await requestReset(player.email);

    const res = await reset(player.email, code, 'short-pw-11');

    expect(res.status).toBe(400);
    expect((await login(e2e, player.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, player.email, 'short-pw-11')).status).toBe(401);
  });

  it('a wrong or expired reset code is refused', async () => {
    const wrongPlayer = await newCredentialPlayer(e2e, 'reset-wrong');
    const expiredPlayer = await newCredentialPlayer(e2e, 'reset-expired');
    const realCode = await requestReset(wrongPlayer.email);
    const expiredCode = await requestReset(expiredPlayer.email);
    await db()
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(verification.identifier, `forget-password-otp-${expiredPlayer.email}`));

    const wrong = await reset(wrongPlayer.email, wrongCode(realCode));
    const expired = await reset(expiredPlayer.email, expiredCode);

    for (const result of [wrong, expired]) {
      expect(result.status).toBe(400);
      expect(errorOf(result.body).message).toBe(INVALID_CODE_MESSAGE);
    }
    expect((await login(e2e, wrongPlayer.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, expiredPlayer.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, expiredPlayer.email, NEW_PASSWORD)).status).toBe(401);
  });

  it('a reset code cannot be used twice', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-twice');
    const code = await requestReset(player.email);
    expect((await reset(player.email, code)).status).toBe(200);

    const replay = await reset(player.email, code, 'attacker-chosen-password');

    expect(replay.status).toBe(400);
    expect(errorOf(replay.body).message).toBe(INVALID_CODE_MESSAGE);
    expect((await login(e2e, player.email, 'attacker-chosen-password')).status).toBe(401);
    expect((await login(e2e, player.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a completed reset ends every other session of the player', async () => {
    const player = await newCredentialPlayer(e2e, 'reset-sessions');
    const clients = await signedInClients(player.email, 2);
    for (const client of [player.client, ...clients]) {
      expect((await client.get('/profile')).status).toBe(200);
    }
    const code = await requestReset(player.email);

    const res = await reset(player.email, code);

    expect(res.status).toBe(200);
    for (const client of [player.client, ...clients]) {
      expect((await client.get('/profile')).status).toBe(401);
    }
    expect(await liveSessionCount(e2e, player.userId)).toBe(0);
  });

  it.todo(
    'BUG: a sign-in that verified the old password while a reset commits keeps its session; a password change sweeps such raced sessions after a delay (packages/core/src/pam/identity/service/identity.service.ts:2446) but a reset ends sessions once only (packages/core/src/pam/identity/service/session.service.ts:309)',
  );

  it('a reset code issued for one player cannot reset another', async () => {
    const owner = await newCredentialPlayer(e2e, 'reset-owner');
    const victim = await newCredentialPlayer(e2e, 'reset-victim');
    const ownerCode = await requestReset(owner.email);

    const res = await reset(victim.email, ownerCode, 'attacker-chosen-password');

    expect(res.status).toBe(400);
    expect(errorOf(res.body).message).toBe(INVALID_CODE_MESSAGE);
    expect((await login(e2e, victim.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, victim.email, 'attacker-chosen-password')).status).toBe(401);
    expect((await login(e2e, owner.email, PASSWORD)).status).toBe(200);
  });
});

describe('password change', () => {
  const change = (client: TestClient, currentPassword: string, newPassword: string) =>
    client.post('/identity/password/change', { currentPassword, newPassword });

  it('a signed-in player changes the password with the correct current password and keeps the current session', async () => {
    const player = await newCredentialPlayer(e2e, 'change-ok');

    const res = await change(player.client, PASSWORD, NEW_PASSWORD);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    const me = await e2e.app.app.request('/profile', { headers: { cookie: cookieOf(res) } });
    expect(me.status).toBe(200);
    expect(await liveSessionCount(e2e, player.userId)).toBe(1);
    expect((await login(e2e, player.email, PASSWORD)).status).toBe(401);
    expect((await login(e2e, player.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a change with a wrong current password is refused and the password is unchanged', async () => {
    const player = await newCredentialPlayer(e2e, 'change-wrong');

    const res = await change(player.client, 'not-the-current-password', NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect((await player.client.get('/profile')).status).toBe(200);
    expect((await login(e2e, player.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, player.email, NEW_PASSWORD)).status).toBe(401);
  });

  it('a successful change ends every other session of the player', async () => {
    const player = await newCredentialPlayer(e2e, 'change-others');
    const others = await signedInClients(player.email, 2);

    const res = await change(player.client, PASSWORD, NEW_PASSWORD);

    expect(res.status).toBe(200);
    for (const client of others) {
      expect((await client.get('/profile')).status).toBe(401);
    }
    expect(await liveSessionCount(e2e, player.userId)).toBe(1);
  });

  it('a session created in a race with the change is ended too', async () => {
    const player = await newCredentialPlayer(e2e, 'change-race');
    const res = await change(player.client, PASSWORD, NEW_PASSWORD);
    expect(res.status).toBe(200);
    const racedToken = `raced-${randomUUID()}`;
    const createdAt = new Date(Date.now() - 5_000);
    await db()
      .insert(session)
      .values({
        id: randomUUID(),
        token: racedToken,
        userId: player.userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt,
        updatedAt: createdAt,
      });

    const deadline = Date.now() + 10_000;
    let remaining = 1;
    while (remaining > 0 && Date.now() < deadline) {
      await delay(250);
      remaining = (await db().select().from(session).where(eq(session.token, racedToken))).length;
    }

    expect(remaining).toBe(0);
    expect(await liveSessionCount(e2e, player.userId)).toBe(1);
  });

  it.todo(
    'BUG: a new password equal to the current one is accepted with 200 and ends the other sessions (packages/core/src/pam/identity/service/identity.service.ts:2351)',
  );
  it('an anonymous caller cannot change a password', async () => {
    const player = await newCredentialPlayer(e2e, 'change-anon');

    const res = await postJson(e2e, '/identity/password/change', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect((await login(e2e, player.email, PASSWORD)).status).toBe(200);
    expect((await login(e2e, player.email, NEW_PASSWORD)).status).toBe(401);
  });
});

describe('admin initiated reset', () => {
  it('an admin with the permission triggers a player password reset and the player sessions end', async () => {
    const player = await newCredentialPlayer(e2e, 'admin-reset');
    const staff = await newStaff(e2e.app, 'admin-reset-staff', 'super-admin');

    const res = await staff.client.post('/identity/admin/password-reset', {
      userId: player.userId,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    const code = await resetCodeFor(player.email);
    expect((await player.client.get('/profile')).status).toBe(200);
    expect((await reset(player.email, code)).status).toBe(200);
    expect((await player.client.get('/profile')).status).toBe(401);
    expect(await liveSessionCount(e2e, player.userId)).toBe(0);
  });

  it('an admin without the permission is refused with forbidden', async () => {
    const player = await newCredentialPlayer(e2e, 'admin-reset-denied');
    const readOnlyStaff = await newStaff(e2e.app, 'admin-reset-read-only', 'affiliate-manager');

    const res = await readOnlyStaff.client.post('/identity/admin/password-reset', {
      userId: player.userId,
    });

    expect(res.status).toBe(403);
    await delay(500);
    expect(capturedEmailsFor(player.email).filter(isResetMail)).toEqual([]);
  });

  it('the reset is recorded in the audit log with the acting admin', async () => {
    const player = await newCredentialPlayer(e2e, 'admin-reset-audit');
    const staff = await newStaff(e2e.app, 'admin-reset-audit-staff', 'super-admin');
    const res = await staff.client.post('/identity/admin/password-reset', {
      userId: player.userId,
    });
    expect(res.status).toBe(200);

    const rows = await vi.waitFor(
      async () => {
        await flushAudit(e2e.app);
        const found = await db()
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'identity.password.admin_reset_requested'),
              eq(auditLog.resourceId, player.userId),
            ),
          );
        if (found.length === 0) {
          throw new Error('admin reset audit row not shipped yet');
        }
        return found;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'admin',
      actorId: staff.userId,
      resourceType: 'user',
    });
  });
});
