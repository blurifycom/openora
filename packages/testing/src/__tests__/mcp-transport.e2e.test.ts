import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loadExtensions, DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { IDENTITY_READER } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { AuditService } from '@openora/core/audit/server';
import { adminRolePermission, mcpToken } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { waitForRowLockWaiter, waitForTableLockWaiter } from '@openora/core/testing';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  registerPlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';
import { MCP_TEST_RATE_LIMIT } from './fixtures/test-mcp-transport-plugin.js';

const MCP_URL = 'http://localhost/mcp';
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' } as const;
const PERSONAL_KEYS = [
  'userId',
  'username',
  'email',
  'firstName',
  'lastName',
  'dateOfBirth',
  'phone',
  'timezone',
  'timezoneUpdatedAt',
];

const IssuedTokenSchema = z.object({ id: z.string(), token: z.string(), tokenPrefix: z.string() });
const TokenSchema = z.object({
  id: z.string(),
  status: z.string(),
  callCount: z.number(),
  lastUsedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
const TokenPageSchema = z.object({ items: z.array(TokenSchema.loose()) });
const IdSchema = z.object({ id: z.string() });
const ErrorReasonSchema = z.object({ data: z.object({ reason: z.string() }) });
const ListItemSchema = z.object({
  id: z.string(),
  admin: z.object({ email: z.string().nullable() }),
});
const NEW_MODERATOR_PASSWORD = 'N3w-moderator-Passw0rd!';
const TextContentSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let moderator: TestClient;
let adminId: string;
let moderatorId: string;
let playerId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

async function userIdOf(email: string): Promise<string> {
  const [row] = await drizzle().select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) {
    throw new Error(`no user ${email}`);
  }
  return row.id;
}

async function issueToken(client: TestClient, label = 'e2e') {
  const res = await client.post('/iam/my-mcp-tokens', { label });
  expect(res.status).toBe(200);
  return IssuedTokenSchema.parse(await res.json());
}

async function myToken(client: TestClient, tokenId: string) {
  const res = await client.get('/iam/my-mcp-tokens');
  expect(res.status).toBe(200);
  const token = TokenPageSchema.parse(await res.json()).items.find((item) => item.id === tokenId);
  if (!token) {
    throw new Error(`token ${tokenId} is not listed`);
  }
  return token;
}

async function revokeReasonOf(tokenId: string): Promise<string | null> {
  const { rows } = await drizzle().execute<{ revoke_reason: string | null }>(
    sql`SELECT revoke_reason FROM mcp_token WHERE id = ${tokenId}`,
  );
  return rows[0]?.revoke_reason ?? null;
}

const appFetch = (url: string | URL, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.app.request(String(url), init));

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: appFetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as Transport;
  await client.connect(transport);
  return client;
}

function rawPost({
  token,
  url = MCP_URL,
  method = 'POST',
  headers = {},
  body = JSON.stringify(PING),
}: {
  token?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  const requestHeaders = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  });
  if (token) {
    requestHeaders.set('authorization', `Bearer ${token}`);
  }
  return Promise.resolve(
    app.app.request(url, {
      method,
      headers: requestHeaders,
      ...(method === 'GET' ? {} : { body }),
    }),
  );
}

function notExposedAuditRows(tokenId: string) {
  return drizzle()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'mcp.tool.failed'),
        sql`${auditLog.after}->>'tokenId' = ${tokenId}`,
        sql`${auditLog.after}->>'error' = 'not_exposed'`,
      ),
    )
    .orderBy(asc(auditLog.seq));
}

function toolAuditRows(tokenId: string) {
  return drizzle()
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, 'mcp.tool.invoked'), sql`${auditLog.after}->>'tokenId' = ${tokenId}`),
    )
    .orderBy(asc(auditLog.seq));
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const fixturePath = fileURLToPath(
    new URL('./fixtures/test-mcp-transport-plugin.ts', import.meta.url),
  );
  app = await bootTestApp({
    plugins: [...(await loadExtensions()), { id: 'test-mcp-transport', path: fixturePath }],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
  moderator = await asAdmin(app.app, { email: 'moderator@oss.dev' });
  adminId = await userIdOf('admin@oss.dev');
  moderatorId = await userIdOf('moderator@oss.dev');
  ({ playerId } = await registerAndMaterializePlayer(app, { email: 'mcp-transport@e2e.test' }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('MCP tokens', () => {
  it('shows the plaintext once and never the hash, and audits the issue without either', async () => {
    const issued = await issueToken(admin, 'claude-code');
    expect(issued.token).toMatch(/^ora_mcp_[A-Za-z0-9_-]{43}$/);
    expect(issued.token.startsWith(issued.tokenPrefix)).toBe(true);

    const res = await admin.get('/iam/my-mcp-tokens');
    const listed = JSON.stringify(await res.json());
    const hash = createHash('sha256').update(issued.token, 'utf8').digest('hex');
    expect(listed).toContain(issued.id);
    expect(listed).not.toContain(issued.token);
    expect(listed).not.toContain(hash);

    const audit = await vi.waitFor(async () => {
      const rows = await drizzle()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'iam.mcp_token.created'), eq(auditLog.resourceId, issued.id)),
        );
      expect(rows).toHaveLength(1);
      return rows;
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(hash);
  });

  it('refuses a lifetime above the cap with a typed reason', async () => {
    const res = await admin.post('/iam/my-mcp-tokens', { label: 'too-long', ttlDays: 91 });

    expect(res.status).toBe(400);
    expect(ErrorReasonSchema.parse(await res.json()).data.reason).toBe('ttl_exceeds_max');
  });

  it("answers another admin's token on the owner route as not found", async () => {
    const theirs = await issueToken(moderator, 'moderator-own');

    const res = await admin.post(`/iam/my-mcp-tokens/${theirs.id}/revoke`, {});

    expect(res.status).toBe(404);
    expect(await revokeReasonOf(theirs.id)).toBeNull();
  });

  it("lets an overseer list and revoke another admin's token", async () => {
    const theirs = await issueToken(moderator, 'moderator-overseen');

    const listed = await admin.get(`/iam/mcp-tokens?adminUserId=${moderatorId}`);
    const items = z.object({ items: z.array(ListItemSchema) }).parse(await listed.json()).items;
    const revoked = await admin.post(`/iam/mcp-tokens/${theirs.id}/revoke`, {});

    expect(listed.status).toBe(200);
    expect(items.find((item) => item.id === theirs.id)?.admin.email).toBe('moderator@oss.dev');
    expect(revoked.status).toBe(200);
    expect(await revokeReasonOf(theirs.id)).toBe('manual');
    expect((await rawPost({ token: theirs.token })).status).toBe(401);
  });
});

describe('MCP transport, happy path through the SDK client', () => {
  it('lists the four read tools under model names, without propose tools or personal keys', async () => {
    const { token } = await issueToken(admin);
    const client = await connect(token);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'ggr_summary',
      'kyc_status',
      'player_summary',
      'wallet_activity',
    ]);
    const summary = tools.find((tool) => tool.name === 'player_summary');
    const properties = Object.keys(summary?.outputSchema?.properties ?? {});
    expect(properties).toContain('status');
    for (const key of [...PERSONAL_KEYS, 'bio']) {
      expect(properties).not.toContain(key);
    }
    expect(summary?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('answers a tool call without personal data, audits it under the token and counts it', async () => {
    const { id, token } = await issueToken(admin);
    const client = await connect(token);

    const result = await client.callTool({ name: 'player_summary', arguments: { playerId } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ playerId });
    for (const key of PERSONAL_KEYS) {
      expect(result.structuredContent).not.toHaveProperty(key);
    }
    const [row, ...rest] = await vi.waitFor(async () => {
      const rows = await toolAuditRows(id);
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ actorId: adminId, resourceId: 'player.summary' });
    expect(row?.after).toMatchObject({
      actorKind: 'mcp_token',
      tokenId: id,
      personalDropped: true,
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const listed = await myToken(admin, id);
    expect(listed.callCount).toBe(1);
    expect(listed.lastUsedAt).not.toBeNull();
    await client.close();
  });

  it('returns kernel failures as tool errors carrying only the code', async () => {
    const { token } = await issueToken(admin);
    const client = await connect(token);

    const missing = await client.callTool({
      name: 'player_summary',
      arguments: { playerId: '00000000-0000-4000-8000-000000000000' },
    });
    const invalid = await client.callTool({ name: 'player_summary', arguments: { playerId: 'x' } });

    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
    expect(JSON.parse(TextContentSchema.parse(missing).content[0]?.text ?? '{}')).toEqual({
      error: 'player_not_found',
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(TextContentSchema.parse(invalid).content[0]?.text ?? '{}')).toMatchObject({
      error: 'invalid_input',
    });
    await client.close();
  });

  it('refuses a propose tool and an action type as unknown tools, and audits both', async () => {
    const { id, token } = await issueToken(admin);
    const client = await connect(token);

    await expect(client.callTool({ name: 'flag_player', arguments: { playerId } })).rejects.toThrow(
      /Unknown tool/,
    );
    await expect(client.callTool({ name: 'hold_withdrawal', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );

    const rows = await notExposedAuditRows(id);
    expect(rows.map((row) => row.resourceId)).toEqual(['flag_player', 'hold_withdrawal']);
    await client.close();
  });
});

describe('MCP transport, refusals before the protocol', () => {
  it('answers a missing or unknown bearer with 401 and no OAuth metadata', async () => {
    const missing = await rawPost({});
    const unknown = await rawPost({ token: `ora_mcp_${randomBytes(32).toString('base64url')}` });

    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('refuses a revoked and an expired token', async () => {
    const revoked = await issueToken(admin);
    const expired = await issueToken(admin);
    expect((await admin.post(`/iam/my-mcp-tokens/${revoked.id}/revoke`, {})).status).toBe(200);
    await drizzle().execute(
      sql`UPDATE mcp_token SET expires_at = now() - interval '1 minute' WHERE id = ${expired.id}`,
    );

    expect((await rawPost({ token: revoked.token })).status).toBe(401);
    expect((await rawPost({ token: expired.token })).status).toBe(401);
    expect(await revokeReasonOf(revoked.id)).toBe('manual');
  });

  it('refuses a browser origin, a GET, an oversized body and an unbound host', async () => {
    const { token } = await issueToken(admin);

    const origin = await rawPost({ token, headers: { origin: 'https://evil.example' } });
    const get = await rawPost({ token, method: 'GET' });
    const oversized = await rawPost({ token, body: 'x'.repeat(1_048_577) });
    const otherHost = await rawPost({ token, url: 'http://player.example.test/mcp' });

    expect(origin.status).toBe(403);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(oversized.status).toBe(413);
    expect(otherHost.status).toBe(404);
  });

  it('marks every answer no-store and adds no CORS header without an origin', async () => {
    const { token } = await issueToken(admin);

    const res = await rawPost({ token });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('limits each token per minute with a Retry-After', async () => {
    const { token } = await issueToken(admin);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < MCP_TEST_RATE_LIMIT.perMinute; attempt += 1) {
      statuses.push((await rawPost({ token })).status);
    }
    const limited = await rawPost({ token });

    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
  });
});

describe('MCP tokens, automatic revocation', () => {
  it('revokes a user tokens when an admin revokes all of their sessions', async () => {
    const { id, token } = await issueToken(moderator);

    const res = await admin.post('/identity/sessions/revoke-all', { userId: moderatorId });

    expect(res.status).toBe(200);
    expect(await revokeReasonOf(id)).toBe('sessions_revoked');
    expect((await rawPost({ token })).status).toBe(401);
    moderator = await asAdmin(app.app, { email: 'moderator@oss.dev' });
  });

  it('revokes on deactivation and keeps the token revoked after reactivation', async () => {
    const { id, token } = await issueToken(moderator);

    expect(
      (await admin.patch(`/backoffice/users/${moderatorId}`, { isActive: false })).status,
    ).toBe(200);
    expect(await revokeReasonOf(id)).toBe('admin_disabled');
    expect((await rawPost({ token })).status).toBe(401);

    expect((await admin.patch(`/backoffice/users/${moderatorId}`, { isActive: true })).status).toBe(
      200,
    );
    expect((await rawPost({ token })).status).toBe(401);
    moderator = await asAdmin(app.app, { email: 'moderator@oss.dev' });
  });

  it('revokes on a password change', async () => {
    const { id, token } = await issueToken(moderator);

    const res = await moderator.post('/identity/password/change', {
      currentPassword: 'password1234',
      newPassword: NEW_MODERATOR_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(await revokeReasonOf(id)).toBe('sessions_revoked');
    expect((await rawPost({ token })).status).toBe(401);
    moderator = await asAdmin(app.app, {
      email: 'moderator@oss.dev',
      password: NEW_MODERATOR_PASSWORD,
    });
  });
});

describe('MCP transport, grants', () => {
  it('lists only what a narrow role grants and refuses the rest, then revokes when MCP access goes', async () => {
    const role = IdSchema.parse(
      await (await admin.post('/iam/roles', { name: 'MCP analyst' })).json(),
    );
    const setGrants = (grants: { resource: string; level: string }[]) =>
      admin.put(`/iam/roles/${role.id}/permissions`, { grants });
    expect(
      (
        await setGrants([
          { resource: 'mcp-access', level: 'read_write' },
          { resource: 'player', level: 'read' },
        ])
      ).status,
    ).toBe(200);
    expect(
      (await admin.post('/iam/assignments', { userId: moderatorId, roleId: role.id })).status,
    ).toBe(200);
    const { id, token } = await issueToken(moderator);
    const client = await connect(token);

    const { tools } = await client.listTools();
    const kyc = await client.callTool({ name: 'kyc_status', arguments: { playerId } });

    expect(tools.map((tool) => tool.name)).toEqual(['player_summary']);
    expect(kyc.isError).toBe(true);
    expect(JSON.parse(TextContentSchema.parse(kyc).content[0]?.text ?? '{}')).toEqual({
      error: 'forbidden',
    });
    expect((await moderator.get('/iam/mcp-tokens')).status).toBe(403);
    expect((await moderator.post('/iam/mcp-tokens/revoke-all', {})).status).toBe(403);
    await client.close();

    expect((await setGrants([{ resource: 'player', level: 'read' }])).status).toBe(200);
    expect(await revokeReasonOf(id)).toBe('admin_role_removed');
    expect((await rawPost({ token })).status).toBe(401);
    expect((await moderator.post('/iam/my-mcp-tokens', { label: 'no-access' })).status).toBe(403);
    expect((await moderator.get('/iam/my-mcp-tokens')).status).toBe(403);
  });
});

describe('MCP tokens, oversight', () => {
  it('revokes every active token at once and audits each one in a valid chain', async () => {
    const issued = [await issueToken(admin), await issueToken(admin), await issueToken(admin)];

    const res = await admin.post('/iam/mcp-tokens/revoke-all', {});

    expect(res.status).toBe(200);
    const { revoked } = z.object({ revoked: z.number() }).parse(await res.json());
    expect(revoked).toBeGreaterThanOrEqual(issued.length);
    const rows = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'iam.mcp_token.revoked'),
          sql`${auditLog.after}->>'reason' = 'revoked_all'`,
        ),
      )
      .orderBy(asc(auditLog.seq));
    expect(rows).toHaveLength(revoked);
    expect(new Set(rows.map((row) => row.resourceId)).size).toBe(revoked);
    expect(rows.map((row) => row.resourceId)).toEqual(
      expect.arrayContaining(issued.map((token) => token.id)),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        actorId: adminId,
        actorType: 'admin',
        resourceType: 'mcp-token',
        before: { revokedAt: null },
        after: expect.objectContaining({ reason: 'revoked_all', tokenPrefix: expect.any(String) }),
      });
    }
    for (const { token } of issued) {
      expect((await rawPost({ token })).status).toBe(401);
    }
    const audit = new AuditService(
      app.container.get(DRIZZLE),
      app.container.get(EVENT_BUS),
      app.container.get(IDENTITY_READER),
    );
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});

describe('MCP tokens, issuing while a grant change takes MCP access away', () => {
  const WITH_MCP = [
    { resource: 'mcp-access', level: 'read_write' },
    { resource: 'player', level: 'read' },
  ];
  const WITHOUT_MCP = [{ resource: 'player', level: 'read' }];

  function tokenIdsOf(adminUserId: string) {
    return drizzle()
      .select({ id: mcpToken.id })
      .from(mcpToken)
      .where(eq(mcpToken.adminUserId, adminUserId));
  }

  async function staffWithRole(grants: { resource: string; level: string }[]) {
    const email = `mcp-race-${randomUUID()}@e2e.test`;
    const userId = await registerPlayer(app, { email });
    await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
    const role = IdSchema.parse(
      await (await admin.post('/iam/roles', { name: `MCP race ${userId}` })).json(),
    );
    const setGrants = (next: { resource: string; level: string }[]) =>
      admin.put(`/iam/roles/${role.id}/permissions`, { grants: next });
    expect((await setGrants(grants)).status).toBe(200);
    expect((await admin.post('/iam/assignments', { userId, roleId: role.id })).status).toBe(200);
    return { userId, roleId: role.id, setGrants, client: await asAdmin(app.app, { email }) };
  }

  function holdPermissionRows(roleId: string) {
    let markHeld = () => {};
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = drizzle().transaction(async (tx) => {
      await tx
        .select({ id: adminRolePermission.id })
        .from(adminRolePermission)
        .where(eq(adminRolePermission.roleId, roleId))
        .for('update');
      markHeld();
      await released;
    });
    return { held, release, committed };
  }

  it('refuses the issue the grant change held back, leaves no token, and issues again once access is back', async () => {
    const staff = await staffWithRole(WITH_MCP);
    const appDb = { drizzle: app.container.get(DRIZZLE) };
    const rows = holdPermissionRows(staff.roleId);
    await rows.held;

    const removing = staff.setGrants(WITHOUT_MCP);
    await waitForRowLockWaiter(appDb);
    const issuing = staff.client.post('/iam/my-mcp-tokens', { label: 'raced' });
    await waitForTableLockWaiter(appDb, mcpToken);
    rows.release();
    await rows.committed;
    const [removed, issued] = await Promise.all([removing, issuing]);

    expect(removed.status).toBe(200);
    expect(issued.status).toBe(403);
    expect(ErrorReasonSchema.parse(await issued.json()).data.reason).toBe('owner_ineligible');
    expect(await tokenIdsOf(staff.userId)).toEqual([]);
    await vi.waitFor(async () => {
      const denials = await drizzle()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'identity.user.unauthorized_access'),
            eq(auditLog.actorId, staff.userId),
            eq(auditLog.resourceId, 'mcp-access:use'),
          ),
        );
      expect(denials).toHaveLength(1);
    });

    expect((await staff.setGrants(WITH_MCP)).status).toBe(200);
    const { id, token } = await issueToken(staff.client, 'after the race');
    expect(await tokenIdsOf(staff.userId)).toEqual([{ id }]);
    expect((await rawPost({ token })).status).toBe(200);
  });
});
