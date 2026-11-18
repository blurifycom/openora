import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createInternalClient,
  DRIZZLE,
  EVENT_BUS,
  InternalApiError,
  loadExtensions,
} from '@openora/core/server';
import { ADMIN_SECURITY_ROUTE } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { bootE2e, bootTestApp, closeE2e, type TestApp, type TestDb } from '../index.js';

// The identity service enforces the Backoffice policy (mandatory second factor, sessions bound to
// a device); the chat service boots with the defaults, which enforce neither. So a verdict the
// chat service honours can only have come from identity, over the signed internal API.
const IDENTITY_SERVICE_URL = 'http://identity.internal';
const CHAT_SERVICE_NAME = 'chat-e2e';
const SHARED_ENV = {
  INTERNAL_API_SECRETS: randomBytes(32).toString('hex'),
  ACCOUNT_READER_CALLERS: CHAT_SERVICE_NAME,
  SESSION_RESOLVER_CALLERS: CHAT_SERVICE_NAME,
};
const CHAT_ENV = {
  SERVICE_MANIFEST: [
    'chat',
    'social',
    'identity:no-routes',
    'audit',
    'mail',
    'compliance',
    'iam',
    'player-management',
    'wallet',
    'gaming',
    'exchange-rate',
  ].join(','),
  SERVICE_NAME: CHAT_SERVICE_NAME,
  REALTIME_NAMESPACE: CHAT_SERVICE_NAME,
  IDENTITY_SERVICE_URL,
};
const SESSION_ENDING_EVENTS = [
  'identity.session.revoked',
  'identity.sessions.revoked_all',
  'identity.user.deactivated',
] as const;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ADMIN_ROUTE = '/backoffice/chat/messages';

let db: TestDb;
let identityApp: TestApp;
let chatApp: TestApp;
let identityUp = true;
let stopBridge: (() => void)[] = [];
const identityCalls: string[] = [];
const realFetch = globalThis.fetch;

const sql = () => identityApp.container.get(DRIZZLE).db;
const adminSecurityCalls = () =>
  identityCalls.filter((path) => path === `/internal/v1${ADMIN_SECURITY_ROUTE}`).length;

async function signInAdmin(userAgent: string): Promise<string> {
  const login = await identityApp.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ email: 'admin@oss.dev', password: 'password1234' }),
  });
  expect(login.status).toBe(200);
  return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function setTwoFactor(enabled: boolean) {
  await sql()
    .update(user)
    .set({ twoFactorEnabled: enabled })
    .where(eq(user.email, 'admin@oss.dev'));
}

/** The chat service's admin route, called with `cookie` from the device `userAgent`. */
async function adminCall(cookie: string, userAgent: string) {
  const res = await chatApp.app.request(ADMIN_ROUTE, {
    headers: { cookie, 'user-agent': userAgent },
  });
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    data?: { reason?: string };
  };
  return { status: res.status, code: body.code, reason: body.data?.reason };
}

beforeAll(async () => {
  Object.assign(process.env, SHARED_ENV);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(IDENTITY_SERVICE_URL)) {
      return realFetch(input, init);
    }
    identityCalls.push(new URL(url).pathname);
    if (!identityUp) {
      throw new TypeError('fetch failed');
    }
    return identityApp.app.request(url, init);
  });
  ({ db, app: identityApp } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-admin-security',
        path: fileURLToPath(new URL('../test-admin-security-plugin.ts', import.meta.url)),
      },
    ],
  }));
  const saved = Object.keys(CHAT_ENV).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, CHAT_ENV);
  try {
    chatApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  // Each booted app owns a Redis database, so the two apps do not share a broker as the two
  // services do in production: carry the events that end a session across the gap.
  stopBridge = SESSION_ENDING_EVENTS.map((topic) =>
    identityApp.container
      .get(EVENT_BUS)
      .on(topic, (payload) => chatApp.container.get(EVENT_BUS).emit(topic, payload)),
  );
}, 90_000);

afterAll(async () => {
  for (const stop of stopBridge) {
    stop();
  }
  vi.unstubAllGlobals();
  for (const key of Object.keys(SHARED_ENV)) {
    delete process.env[key];
  }
  await chatApp?.close();
  await closeE2e({ app: identityApp, db });
});

describe('chat on its own service, with the Backoffice policy decided by identity', () => {
  it('refuses a staff member who has not enrolled a second factor, though chat enforces none itself', async () => {
    await setTwoFactor(false);
    const cookie = await signInAdmin(CHROME_UA);
    identityCalls.length = 0;

    const refused = await adminCall(cookie, CHROME_UA);

    expect(refused).toMatchObject({ status: 403, reason: 'two_factor_required' });
    expect(adminSecurityCalls()).toBe(1);
  });

  it('serves an enrolled staff member on their own device, asking identity on every request', async () => {
    const cookie = await signInAdmin(CHROME_UA);
    await setTwoFactor(true);
    identityCalls.length = 0;

    const first = await adminCall(cookie, CHROME_UA);
    const second = await adminCall(cookie, CHROME_UA);

    expect([first.status, second.status]).toEqual([200, 200]);
    // Enrolment and device, each time: a verdict is never kept.
    expect(adminSecurityCalls()).toBe(4);
    await setTwoFactor(false);
  });

  it('ends a staff session used from another device, and does not serve it again from chat cache', async () => {
    const cookie = await signInAdmin(CHROME_UA);
    await setTwoFactor(true);
    expect((await adminCall(cookie, CHROME_UA)).status).toBe(200);

    const stolen = await adminCall(cookie, SAFARI_UA);
    // Chat still holds the session it resolved a moment ago; identity knows it has ended.
    const owner = await adminCall(cookie, CHROME_UA);

    expect(stolen).toMatchObject({ status: 401, reason: 'session_fingerprint_mismatch' });
    expect(owner.status).toBe(401);
    await setTwoFactor(false);
  });

  it('refuses, rather than skips the checks, while identity cannot be reached', async () => {
    const cookie = await signInAdmin(CHROME_UA);
    await setTwoFactor(true);
    expect((await adminCall(cookie, CHROME_UA)).status).toBe(200);

    identityUp = false;
    const down = await adminCall(cookie, CHROME_UA).finally(() => {
      identityUp = true;
    });

    expect(down.status).toBe(503);
    expect((await adminCall(cookie, CHROME_UA)).status).toBe(200);
    await setTwoFactor(false);
  });

  it('refuses a service that is not an allowed session caller', async () => {
    const rogue = createInternalClient({
      baseUrl: IDENTITY_SERVICE_URL,
      serviceName: 'rogue-service',
      audience: 'monolith',
      secrets: process.env['INTERNAL_API_SECRETS'],
      timeoutMs: 5_000,
    });

    const err = await rogue
      .request('POST', ADMIN_SECURITY_ROUTE, {
        check: 'enrolled',
        userId: 'x',
        sessionId: null,
        ip: null,
        userAgent: null,
      })
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(InternalApiError);
    expect(err).toMatchObject({ status: 403 });
  });
});
