import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { mcpToken } from '@openora/core/iam/schema';
import { account, user } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerPlayer,
  asAdmin,
  asPlayer,
  waitForEmail,
  clearCapturedEmails,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

const MCP_URL = 'http://localhost/mcp';
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' } as const;
const PASSWORD = 'password1234';
const NEW_PASSWORD = 'brand-new-staff-passw0rd';
const RESET_SUBJECT = 'Reset your password';
const TWO_FACTOR_SUBJECT = 'Your verification code';

const IssuedTokenSchema = z.object({ id: z.string(), token: z.string() });

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;

function postJson(path: string, body: unknown, cookie?: string) {
  return Promise.resolve(
    app.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function ping(token: string) {
  return Promise.resolve(
    app.app.request(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(PING),
    }),
  );
}

function cookiesOf(res: Response) {
  return (res.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join('; ');
}

async function codeMailedTo(email: string, subject: string) {
  const mail = await waitForEmail(email, (sent) => sent.subject === subject);
  const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
  if (!code) {
    throw new Error(`no six-digit code in "${subject}" for ${email}`);
  }
  return code;
}

async function newPlayer() {
  const email = `credential-stamp-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  return { email, userId, client: await asPlayer(app.app, { email, password: PASSWORD }) };
}

async function newStaff() {
  const email = `mcp-credentials-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  return { email, userId, client: await asAdmin(app.app, { email, password: PASSWORD }) };
}

async function issueToken(client: TestClient) {
  const res = await client.post('/iam/my-mcp-tokens', { label: 'laptop' });
  expect(res.status).toBe(200);
  return IssuedTokenSchema.parse(await res.json());
}

async function credentialStamp(userId: string) {
  const [row] = await drizzle()
    .select({ updatedAt: account.updatedAt })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
  if (!row) {
    throw new Error(`no credential account for ${userId}`);
  }
  return row.updatedAt;
}

async function revocationOf(tokenId: string) {
  const [row] = await drizzle()
    .select({ revokedAt: mcpToken.revokedAt, revokeReason: mcpToken.revokeReason })
    .from(mcpToken)
    .where(eq(mcpToken.id, tokenId));
  return row;
}

async function resetPassword(email: string, newPassword: string) {
  expect((await postJson('/identity/password/forgot', { email })).status).toBe(200);
  const otp = await codeMailedTo(email, RESET_SUBJECT);
  return postJson('/identity/password/reset', { email, otp, newPassword });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      { id: 'test-mcp-transport', path: fixture('test-mcp-transport-plugin.ts') },
      {
        id: 'test-failing-mcp-token-revocation',
        path: fixture('test-failing-mcp-token-revocation-plugin.ts'),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('the credential stamp the MCP token gate reads', () => {
  it('moves on a password change and again on a password reset', async () => {
    const { email, userId, client } = await newPlayer();
    const registered = await credentialStamp(userId);

    const changed = await client.post('/identity/password/change', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const afterChange = await credentialStamp(userId);
    const reset = await resetPassword(email, `${NEW_PASSWORD}-again`);
    const afterReset = await credentialStamp(userId);

    expect(changed.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(afterChange.getTime()).toBeGreaterThan(registered.getTime());
    expect(afterReset.getTime()).toBeGreaterThan(afterChange.getTime());
  });

  it('stays put through sign-ins, a failed sign-in, and a two-factor enrolment and sign-in', async () => {
    const { email, userId, client } = await newPlayer();
    const registered = await credentialStamp(userId);

    expect((await postJson('/identity/login', { email, password: PASSWORD })).status).toBe(200);
    expect((await postJson('/identity/login', { email, password: 'wrong-password' })).ok).toBe(
      false,
    );
    clearCapturedEmails();
    expect(
      (await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' })).status,
    ).toBe(200);
    const enrolled = await client.post('/identity/2fa/verify', {
      code: await codeMailedTo(email, TWO_FACTOR_SUBJECT),
      method: 'otp',
    });
    const challenge = await postJson('/identity/login', { email, password: PASSWORD });
    const pending = cookiesOf(challenge);
    clearCapturedEmails();
    const sent = await app.app.request('/identity/2fa/otp/send', {
      method: 'POST',
      headers: { cookie: pending },
    });
    const signedIn = await postJson(
      '/identity/2fa/verify',
      { code: await codeMailedTo(email, TWO_FACTOR_SUBJECT), method: 'otp' },
      pending,
    );

    expect(enrolled.status).toBe(200);
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    expect(sent.status).toBe(200);
    expect(signedIn.status).toBe(200);
    expect(await credentialStamp(userId)).toEqual(registered);
  });
});

describe('MCP tokens when revoking them after a credential change fails', () => {
  it('refuses a token issued before a password change and serves one issued after it', async () => {
    const staff = await newStaff();
    const bystander = await newStaff();
    const before = await issueToken(staff.client);
    const bystanders = await issueToken(bystander.client);
    expect((await ping(before.token)).status).toBe(200);

    const changed = await staff.client.post('/identity/password/change', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(changed.status).toBe(200);
    expect(await revocationOf(before.id)).toEqual({ revokedAt: null, revokeReason: null });
    expect((await ping(before.token)).status).toBe(401);
    expect((await ping(bystanders.token)).status).toBe(200);
    const signedInAgain = await asAdmin(app.app, { email: staff.email, password: NEW_PASSWORD });
    const after = await issueToken(signedInAgain);
    expect((await ping(after.token)).status).toBe(200);
  });

  it('refuses a token issued before a password reset, and the old session cannot issue another', async () => {
    const staff = await newStaff();
    const before = await issueToken(staff.client);
    expect((await ping(before.token)).status).toBe(200);

    const reset = await resetPassword(staff.email, NEW_PASSWORD);

    expect(reset.status).toBe(200);
    expect(await revocationOf(before.id)).toEqual({ revokedAt: null, revokeReason: null });
    expect((await ping(before.token)).status).toBe(401);
    expect(
      (await staff.client.post('/iam/my-mcp-tokens', { label: 'stolen session' })).status,
    ).toBe(401);
    const signedInAgain = await asAdmin(app.app, { email: staff.email, password: NEW_PASSWORD });
    const after = await issueToken(signedInAgain);
    expect((await ping(after.token)).status).toBe(200);
  });
});
