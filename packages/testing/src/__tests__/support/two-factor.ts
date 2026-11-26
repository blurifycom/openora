import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { session, user } from '@openora/core/pam/schema/identity';
import { secretFromTotpUri, totpCode, type E2e } from '../../index.js';
import { LoginSuccessSchema, newCredentialPlayer, postJson } from './identity.js';

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0';
export const OTHER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0';

export const EnableSchema = z.object({ totpUri: z.string(), backupCodes: z.array(z.string()) });
export const StatusSchema = z.object({
  enabled: z.boolean(),
  method: z.string().nullable(),
  backupCodesRemaining: z.number().nullable(),
});
export const ChallengeSchema = z.object({
  twoFactorRedirect: z.literal(true),
  trustedDeviceDays: z.number(),
});
export const VerifySchema = z.object({ success: z.literal(true), trustGranted: z.boolean() });
export const BackupCodesSchema = z.object({ backupCodes: z.array(z.string()) });
export const TrustedDevicesSchema = z.array(
  z.object({ id: z.string(), isCurrent: z.boolean(), expiresAt: z.string() }),
);

export type Jar = Map<string, string>;

export function absorbCookies(jar: Jar, res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair = ''] = line.split(';');
    const at = pair.indexOf('=');
    if (at < 1) {
      continue;
    }
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === '' || /max-age=0/i.test(line)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

export const cookieHeaderOf = (jar: Jar) =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

export type Browser = { jar: Jar; userAgent: string; ip?: string };

export const newBrowser = (userAgent = USER_AGENT): Browser => ({ jar: new Map(), userAgent });

export async function call(
  e2e: E2e,
  browser: Browser,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const cookie = cookieHeaderOf(browser.jar);
  const headers = {
    'user-agent': browser.userAgent,
    ...(browser.ip ? { 'x-real-ip': browser.ip } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const result =
    method === 'POST'
      ? await postJson(e2e, path, body ?? {}, headers)
      : method === 'DELETE'
        ? await deleteJson(e2e, path, body ?? {}, headers)
        : await getJson(e2e, path, headers);
  absorbCookies(browser.jar, result.res);
  return result;
}

async function deleteJson(e2e: E2e, path: string, body: unknown, headers: Record<string, string>) {
  const res = await e2e.app.app.request(path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => null);
  return { res, status: res.status, body: parsed };
}

async function getJson(e2e: E2e, path: string, headers: Record<string, string>) {
  const res = await e2e.app.app.request(path, { method: 'GET', headers });
  const parsed: unknown = await res.json().catch(() => null);
  return { res, status: res.status, body: parsed };
}

export const loginBrowser = (e2e: E2e, browser: Browser, email: string, password: string) =>
  call(e2e, browser, 'POST', '/identity/login', { email, password });

export const verifyCode = (
  e2e: E2e,
  browser: Browser,
  code: string,
  extras: { method?: 'totp' | 'backup_code'; trustDevice?: boolean } = {},
) => call(e2e, browser, 'POST', '/identity/2fa/verify', { code, ...extras });

export const meStatus = (e2e: E2e, browser: Browser) => call(e2e, browser, 'GET', '/identity/me');

export async function hasSession(e2e: E2e, browser: Browser) {
  const res = await meStatus(e2e, browser);
  return res.status === 200 && res.body !== null;
}

export type EnrolledPlayer = {
  userId: string;
  email: string;
  password: string;
  secret: string;
  backupCodes: string[];
};

export async function enrolledPlayer(
  e2e: E2e,
  prefix = 'tfa',
  options: { requireOnLogin?: boolean } = {},
): Promise<EnrolledPlayer> {
  const account = await newCredentialPlayer(e2e, prefix);
  const browser = newBrowser();
  const login = await loginBrowser(e2e, browser, account.email, account.password);
  LoginSuccessSchema.parse(login.body);
  const enable = await call(e2e, browser, 'POST', '/identity/2fa/enable', {
    password: account.password,
  });
  const enabled = EnableSchema.parse(enable.body);
  const secret = secretFromTotpUri(enabled.totpUri);
  const verified = await verifyCode(e2e, browser, totpCode(secret));
  VerifySchema.parse(verified.body);
  if (options.requireOnLogin) {
    await call(e2e, browser, 'POST', '/identity/security/require-two-factor', { enabled: true });
  }
  return {
    userId: account.userId,
    email: account.email,
    password: account.password,
    secret,
    backupCodes: enabled.backupCodes,
  };
}

export async function challengedBrowser(e2e: E2e, player: EnrolledPlayer, userAgent = USER_AGENT) {
  const browser = newBrowser(userAgent);
  const login = await loginBrowser(e2e, browser, player.email, player.password);
  return { browser, login };
}

export async function signInWithCode(e2e: E2e, player: EnrolledPlayer, userAgent = USER_AGENT) {
  const { browser } = await challengedBrowser(e2e, player, userAgent);
  const verified = await verifyCode(e2e, browser, totpCode(player.secret));
  VerifySchema.parse(verified.body);
  return browser;
}

export const twoFactorRow = async (e2e: E2e, userId: string) => {
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select({
      failed: user.failedTwoFactorAttempts,
      lockoutUntil: user.twoFactorLockoutUntil,
      enabled: user.twoFactorEnabled,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!row) {
    throw new Error(`no user ${userId}`);
  }
  return row;
};

export async function idleSessionsFor(e2e: E2e, userId: string, minutesAgo: number) {
  await e2e.app.container
    .get(DRIZZLE)
    .db.update(session)
    .set({ lastSeenAt: new Date(Date.now() - minutesAgo * 60_000) })
    .where(eq(session.userId, userId));
}

export async function sessionExpiries(e2e: E2e, userId: string) {
  const rows = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.userId, userId));
  return rows.map((row) => row.expiresAt.getTime());
}

export async function switchToSmsMethod(e2e: E2e, userId: string) {
  const phoneNumber = `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  await e2e.app.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ twoFactorMethod: 'sms', phoneNumber, phoneVerified: true })
    .where(eq(user.id, userId));
}

export const wrongCode = (secret: string) => {
  const valid = [-1, 0, 1].map((step) => totpCode(secret, Date.now() + step * 30_000));
  return ['000000', '111111', '222222'].find((code) => !valid.includes(code)) ?? '333333';
};
