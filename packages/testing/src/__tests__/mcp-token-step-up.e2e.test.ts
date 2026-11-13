import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { IDENTITY_READER } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { mcpToken } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  registerPlayer,
  secretFromTotpUri,
  totpCode,
  type TestApp,
  type TestClient,
  type TestDb,
  flushAudit,
} from '../index.js';

const PASSWORD = 'password1234';
const MCP_GRANTS = [{ resource: 'mcp-access', level: 'read_write' }];

const IssuedTokenSchema = z.object({ id: z.string(), token: z.string() });
const RefusalSchema = z.object({
  data: z.object({ reason: z.string(), attemptsLeft: z.number().optional() }),
});
const IdSchema = z.object({ id: z.string() });
const EnrolmentSchema = z.object({ totpUri: z.string() });

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

beforeAll(async () => {
  const fixturePath = fileURLToPath(
    new URL('./fixtures/test-mcp-transport-plugin.ts', import.meta.url),
  );
  ({ db, app } = await bootE2e({
    plugins: [...(await loadExtensions()), { id: 'test-mcp-transport', path: fixturePath }],
  }));
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

type Poster = Pick<TestClient, 'post'>;

/** A staff account whose only role grants MCP access, signed in with its password. */
async function staffWithMcpAccess() {
  const email = `mcp-step-up-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const role = IdSchema.parse(
    await (await admin.post('/iam/roles', { name: `MCP step-up ${userId}` })).json(),
  );
  expect(
    (await admin.put(`/iam/roles/${role.id}/permissions`, { grants: MCP_GRANTS })).status,
  ).toBe(200);
  expect((await admin.post('/iam/assignments', { userId, roleId: role.id })).status).toBe(200);
  return { userId, client: await asAdmin(app.app, { email, password: PASSWORD }) };
}

/** Clearing the enrolment code rotates the session, so the client follows the new cookie. */
function followCookie(res: Response): Poster {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return {
    post: async (path, body) =>
      app.app.request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

async function enrolAuthenticator(client: TestClient) {
  const enable = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'app' });
  expect(enable.status).toBe(200);
  const secret = secretFromTotpUri(EnrolmentSchema.parse(await enable.json()).totpUri);
  const verify = await client.post('/identity/2fa/verify', {
    code: totpCode(secret),
    method: 'totp',
  });
  expect(verify.status).toBe(200);
  return { secret, client: followCookie(verify) };
}

const issue = (client: Poster, proof: { currentPassword?: string; totpCode?: string }) =>
  client.post('/iam/my-mcp-tokens', { label: 'step-up', ...proof });

async function refusalOf(res: Response) {
  return RefusalSchema.parse(await res.json()).data;
}

function tokensOf(userId: string) {
  return drizzle()
    .select({ id: mcpToken.id })
    .from(mcpToken)
    .where(eq(mcpToken.adminUserId, userId));
}

async function mcpAccessDenialsOf(userId: string) {
  await flushAudit(app);
  return drizzle()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'identity.user.unauthorized_access'),
        eq(auditLog.actorId, userId),
        eq(auditLog.resourceId, 'mcp-access:use'),
      ),
    );
}

async function secondFactorFailuresOf(userId: string) {
  const playerId = await app.container.get(IDENTITY_READER).getPlayerIdByUserIdSafe(userId);
  await flushAudit(app);
  return drizzle()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'identity.2fa.failed'),
        inArray(auditLog.actorId, playerId ? [userId, playerId] : [userId]),
      ),
    );
}

async function failedTwoFactorAttemptsOf(userId: string) {
  const [row] = await drizzle()
    .select({ attempts: user.failedTwoFactorAttempts })
    .from(user)
    .where(eq(user.id, userId));
  return row?.attempts;
}

/** A well-formed code that is not the one the authenticator shows right now. */
function wrongCode(secret: string) {
  return String((Number(totpCode(secret)) + 500_000) % 1_000_000).padStart(6, '0');
}

describe('MCP token issuance re-authenticates the admin', () => {
  it('refuses a request without the password, and one with a wrong password, issuing nothing and auditing the refusal', async () => {
    const staff = await staffWithMcpAccess();

    const missing = await issue(staff.client, {});
    expect(missing.status).toBe(400);

    const wrong = await issue(staff.client, { currentPassword: 'not-the-password' });
    expect(wrong.status).toBe(403);
    expect(await refusalOf(wrong)).toEqual({ reason: 'reauthentication_failed' });

    expect(await tokensOf(staff.userId)).toEqual([]);
    await vi.waitFor(async () => {
      expect(await mcpAccessDenialsOf(staff.userId)).toHaveLength(1);
    });
  });

  it('issues a working token with the right password', async () => {
    const staff = await staffWithMcpAccess();

    const res = await issue(staff.client, { currentPassword: PASSWORD });

    expect(res.status).toBe(200);
    const issued = IssuedTokenSchema.parse(await res.json());
    expect(await tokensOf(staff.userId)).toEqual([{ id: issued.id }]);
    expect(await mcpAccessDenialsOf(staff.userId)).toEqual([]);
  });
});

describe('MCP token issuance on an account with an authenticator enrolled', () => {
  it('asks for a code, refuses and counts a wrong one, and issues with the right one', async () => {
    const staff = await staffWithMcpAccess();
    const { secret, client } = await enrolAuthenticator(staff.client);

    const withoutCode = await issue(client, { currentPassword: PASSWORD });
    expect(withoutCode.status).toBe(422);
    expect(await refusalOf(withoutCode)).toEqual({ reason: 'reauthentication_required' });

    const withWrongCode = await issue(client, {
      currentPassword: PASSWORD,
      totpCode: wrongCode(secret),
    });
    expect(withWrongCode.status).toBe(403);
    expect(await refusalOf(withWrongCode)).toEqual({
      reason: 'reauthentication_failed',
      attemptsLeft: 4,
    });
    expect(await failedTwoFactorAttemptsOf(staff.userId)).toBe(1);
    expect(await tokensOf(staff.userId)).toEqual([]);
    await vi.waitFor(async () => {
      expect(await secondFactorFailuresOf(staff.userId)).toHaveLength(1);
      expect(await mcpAccessDenialsOf(staff.userId)).toHaveLength(2);
    });

    const withCode = await issue(client, { currentPassword: PASSWORD, totpCode: totpCode(secret) });
    expect(withCode.status).toBe(200);
    const issued = IssuedTokenSchema.parse(await withCode.json());
    expect(await tokensOf(staff.userId)).toEqual([{ id: issued.id }]);
    expect(await failedTwoFactorAttemptsOf(staff.userId)).toBe(0);
  });
});
