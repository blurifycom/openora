import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { capturedEmailsFor } from '../index.js';
import {
  LoginSuccessSchema,
  PASSWORD,
  WRONG_PASSWORD,
  newCredentialPlayer,
  smsCapturePlugin,
  userRow,
} from './support/identity.js';
import { smsCodesFor } from './support/test-sms-capture-plugin.js';
import {
  OTHER_USER_AGENT,
  call,
  idleSessionsFor,
  loginBrowser,
  newBrowser,
  type Browser,
} from './support/two-factor.js';
import {
  bootWalletE2e,
  closeWalletE2e,
  newFundedPlayer,
  postWithdrawal,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([smsCapturePlugin]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const SessionListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      current: z.boolean(),
      deviceLabel: z.string(),
      ipAddress: z.string().nullable().optional(),
    }),
  ),
});

const ControlsSchema = z.object({
  autoLogoutDuration: z.string(),
  loginWithdrawalAlertsEnabled: z.boolean(),
  withdrawalPinSet: z.boolean(),
  antiPhishingCode: z.string().nullable(),
  requireTwoFactorOnLogin: z.boolean(),
  phoneVerified: z.boolean(),
  phoneNumber: z.string().nullable(),
});

async function signedIn(email: string, password = PASSWORD, userAgent?: string) {
  const browser = newBrowser(userAgent);
  const login = await loginBrowser(e2e, browser, email, password);
  expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
  return browser;
}

async function ownSessions(browser: Browser) {
  const res = await call(e2e, browser, 'GET', '/identity/sessions/me');
  expect(res.status).toBe(200);
  return SessionListSchema.parse(res.body).items;
}

async function currentSessionId(browser: Browser) {
  const current = (await ownSessions(browser)).find((item) => item.current);
  if (!current) {
    throw new Error('no current session marked');
  }
  return current.id;
}

const alive = async (browser: Browser) =>
  (await call(e2e, browser, 'GET', '/identity/security/me')).status === 200;

const controlsOf = async (browser: Browser) =>
  ControlsSchema.parse((await call(e2e, browser, 'GET', '/identity/security/me')).body);

describe('session management', () => {
  it.todo(
    'a player lists their sessions and sees device label, country and the current one marked',
  );

  it('a player revokes another session and that session is refused on its next request', async () => {
    const player = await newCredentialPlayer(e2e, 'sess-revoke');
    const first = await signedIn(player.email);
    const second = await signedIn(player.email, PASSWORD, OTHER_USER_AGENT);
    const secondId = await currentSessionId(second);
    expect(await alive(second)).toBe(true);

    const revoked = await call(e2e, first, 'POST', '/identity/sessions/me/revoke', {
      id: secondId,
    });

    expect(revoked.status).toBe(200);
    expect(await alive(second)).toBe(false);
    expect(await alive(first)).toBe(true);
  });

  it('a player cannot revoke a session of another player', async () => {
    const victim = await newCredentialPlayer(e2e, 'sess-victim');
    const attacker = await newCredentialPlayer(e2e, 'sess-attacker');
    const victimBrowser = await signedIn(victim.email);
    const attackerBrowser = await signedIn(attacker.email);
    const victimSessionId = await currentSessionId(victimBrowser);

    const attempt = await call(e2e, attackerBrowser, 'POST', '/identity/sessions/me/revoke', {
      id: victimSessionId,
    });
    const adminRoute = await call(e2e, attackerBrowser, 'POST', '/identity/sessions/revoke', {
      userId: victim.userId,
      id: victimSessionId,
    });

    expect(attempt.status).toBe(404);
    expect(adminRoute.status).toBe(403);
    expect(await alive(victimBrowser)).toBe(true);
  });

  it('revoking the current session through the other-session route is refused', async () => {
    const player = await newCredentialPlayer(e2e, 'sess-self');
    const browser = await signedIn(player.email);

    const attempt = await call(e2e, browser, 'POST', '/identity/sessions/me/revoke', {
      id: await currentSessionId(browser),
    });

    expect(attempt.status).toBe(409);
    expect(await alive(browser)).toBe(true);
  });

  it.todo('revoke all ends every session except the current one');

  it('a revoked session is closed on the live session stream', async () => {
    const player = await newCredentialPlayer(e2e, 'sess-stream');
    const watched = await signedIn(player.email, PASSWORD, OTHER_USER_AGENT);
    const actor = await signedIn(player.email);
    const watchedId = await currentSessionId(watched);
    const abort = new AbortController();
    const stream = await e2e.app.app.request('/identity/session/stream', {
      method: 'GET',
      headers: { cookie: [...watched.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) {
      throw new Error('session stream has no body');
    }
    const decoder = new TextDecoder();
    let received = '';
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) {
          return;
        }
        received += decoder.decode(chunk.value);
      }
    })();

    try {
      const revoked = await call(e2e, actor, 'POST', '/identity/sessions/me/revoke', {
        id: watchedId,
      });
      expect(revoked.status).toBe(200);

      await vi.waitFor(() => expect(received).toContain('revoked'), { timeout: 10_000 });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    }
  });

  it('logout ends the session and the cookie no longer authenticates', async () => {
    const player = await newCredentialPlayer(e2e, 'sess-logout');
    const browser = await signedIn(player.email);
    const staleCookies = new Map(browser.jar);
    expect(await alive(browser)).toBe(true);

    const logout = await call(e2e, browser, 'POST', '/identity/logout');

    expect(logout.status).toBe(200);
    const replay: Browser = { jar: staleCookies, userAgent: browser.userAgent };
    expect(await alive(replay)).toBe(false);
    expect((await call(e2e, replay, 'GET', '/profile')).status).toBe(401);
  });

  it('an idle session past the auto logout setting is refused', async () => {
    const player = await newCredentialPlayer(e2e, 'sess-idle');
    const browser = await signedIn(player.email);
    const set = await call(e2e, browser, 'POST', '/identity/security/auto-logout', {
      duration: '15m',
    });
    expect(set.status).toBe(200);
    expect(await alive(browser)).toBe(true);
    await idleSessionsFor(e2e, player.userId, 16);

    const refused = await call(e2e, browser, 'GET', '/identity/security/me');

    expect(refused.status).toBe(401);
    expect(await alive(browser)).toBe(false);
  });

  it('a mid-session IP change under the strict policy ends the session', async () => {
    const strictE2e = await bootWalletE2e([
      {
        id: 'testing-strict-session',
        path: new URL('./support/test-strict-session-plugin.ts', import.meta.url).pathname,
      },
    ]);
    try {
      const staff = {
        ...newBrowser(),
        ip: '203.0.113.10',
      };
      const login = await loginBrowser(strictE2e, staff, 'admin@oss.dev', 'password1234');
      expect(LoginSuccessSchema.safeParse(login.body).success).toBe(true);
      const sameIp = await call(strictE2e, staff, 'GET', '/identity/sessions/all');
      expect(sameIp.status).toBe(200);

      const moved = await call(
        strictE2e,
        { ...staff, ip: '203.0.113.99' },
        'GET',
        '/identity/sessions/all',
      );

      expect(moved.status).toBe(401);
      const afterwards = await call(strictE2e, staff, 'GET', '/identity/sessions/all');
      expect(afterwards.status).toBe(401);
    } finally {
      await closeWalletE2e(strictE2e);
    }
  });
});

describe('player security controls', () => {
  it('a player sets the auto logout interval and the setting is returned by the security status', async () => {
    const player = await newCredentialPlayer(e2e, 'sec-autologout');
    const browser = await signedIn(player.email);

    const set = await call(e2e, browser, 'POST', '/identity/security/auto-logout', {
      duration: '24h',
    });

    expect(set.status).toBe(200);
    expect(ControlsSchema.parse(set.body).autoLogoutDuration).toBe('24h');
    expect((await controlsOf(browser)).autoLogoutDuration).toBe('24h');
    expect((await userRow(e2e, player.userId)).autoLogoutDuration).toBe('24h');
    const invalid = await call(e2e, browser, 'POST', '/identity/security/auto-logout', {
      duration: '5m',
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
  });

  it('a player enables the login and withdrawal alert and the setting persists', async () => {
    const player = await newCredentialPlayer(e2e, 'sec-alerts');
    const browser = await signedIn(player.email);
    expect((await controlsOf(browser)).loginWithdrawalAlertsEnabled).toBe(false);

    const set = await call(e2e, browser, 'POST', '/identity/security/login-withdrawal-alerts', {
      enabled: true,
    });

    expect(set.status).toBe(200);
    const fresh = await signedIn(player.email);
    expect((await controlsOf(fresh)).loginWithdrawalAlertsEnabled).toBe(true);
    expect((await userRow(e2e, player.userId)).loginWithdrawalAlertsEnabled).toBe(true);
  });

  it('a player sets a withdrawal PIN and a wrong PIN is refused afterwards', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const email = (await userRowByUserId(player.userId)).email;
    const browser = await signedIn(email);
    const set = await call(e2e, browser, 'POST', '/identity/security/withdrawal-pin', {
      pin: '4821',
      confirmPin: '4821',
      currentPassword: PASSWORD,
    });
    expect(set.status).toBe(200);
    expect(ControlsSchema.parse(set.body).withdrawalPinSet).toBe(true);

    const wrong = await postWithdrawal(player.client, player, {
      amount: '10',
      withdrawalPin: '0000',
    });

    expect(wrong.status).toBe(409);
    expect(wrong.body).toEqual(
      expect.objectContaining({ data: { reason: 'withdrawal_pin_incorrect', attemptsLeft: 4 } }),
    );
  });

  it('removing the withdrawal PIN requires the current credentials', async () => {
    const player = await newCredentialPlayer(e2e, 'sec-pin-remove');
    const browser = await signedIn(player.email);
    await call(e2e, browser, 'POST', '/identity/security/withdrawal-pin', {
      pin: '4821',
      confirmPin: '4821',
      currentPassword: PASSWORD,
    });

    const wrong = await call(e2e, browser, 'DELETE', '/identity/security/withdrawal-pin', {
      currentPassword: WRONG_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect((await controlsOf(browser)).withdrawalPinSet).toBe(true);

    const removed = await call(e2e, browser, 'DELETE', '/identity/security/withdrawal-pin', {
      currentPassword: PASSWORD,
    });
    expect(removed.status).toBe(200);
    expect((await controlsOf(browser)).withdrawalPinSet).toBe(false);
  });

  it('setting an anti phishing code shows it in later security emails', async () => {
    const player = await newCredentialPlayer(e2e, 'sec-antiphish');
    const browser = await signedIn(player.email);
    const code = `phrase-${Date.now()}`;

    const set = await call(e2e, browser, 'POST', '/identity/security/anti-phishing-code', {
      code,
    });
    expect(set.status).toBe(200);
    expect(ControlsSchema.parse(set.body).antiPhishingCode).toBe(code);

    const forgot = await call(e2e, newBrowser(), 'POST', '/identity/password/forgot', {
      email: player.email,
    });
    expect(forgot.status).toBe(200);
    await vi.waitFor(
      () => {
        const mails = capturedEmailsFor(player.email).filter((mail) => mail.text.includes(code));
        expect(mails.length).toBeGreaterThan(0);
      },
      { timeout: 20_000 },
    );
  });

  it.todo('a player requires two factor on withdrawals and the setting persists');

  it('a player verifies a phone with a code and a wrong code is refused', async () => {
    const player = await newCredentialPlayer(e2e, 'sec-phone');
    const browser = await signedIn(player.email);
    const phone = `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const requested = await call(e2e, browser, 'POST', '/identity/phone-verification/request', {
      phone,
      currentPassword: PASSWORD,
    });
    expect(requested.status).toBe(200);
    const [code] = smsCodesFor(phone);
    expect(code).toMatch(/^[0-9]{6}$/);

    const wrong = await call(e2e, browser, 'POST', '/identity/phone-verification/confirm', {
      code: code === '000000' ? '000001' : '000000',
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await controlsOf(browser)).phoneVerified).toBe(false);

    const confirmed = await call(e2e, browser, 'POST', '/identity/phone-verification/confirm', {
      code,
    });
    expect(confirmed.status).toBe(200);
    const controls = ControlsSchema.parse(confirmed.body);
    expect(controls.phoneVerified).toBe(true);
    expect(controls.phoneNumber).toBe(phone);
  });
});

async function userRowByUserId(userId: string) {
  const [row] = await db().select().from(user).where(eq(user.id, userId));
  if (!row) {
    throw new Error(`no user ${userId}`);
  }
  return row;
}
