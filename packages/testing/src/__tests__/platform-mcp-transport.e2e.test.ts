import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRolePermission, adminRoleAssignment } from '@openora/core/iam/schema';
import { newPlayer, type E2e } from '../index.js';
import {
  JsonRpcSchema,
  ToolResultSchema,
  ToolsListSchema,
  bootMcpE2e,
  closeE2e,
  issueToken,
  mcpCall,
  newMcpAdmin,
  toolsCall,
  toolsList,
  tokenRow,
} from './support/mcp.js';
import { MCP_TEST_LIMITS, MCP_TEST_ORIGIN } from './support/test-mcp-plugin.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootMcpE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

async function adminToken(roleKey = 'admin') {
  const admin = await newMcpAdmin(e2e, roleKey);
  return { admin, issued: await issueToken(admin) };
}

async function mcpOnlyAdmin() {
  const admin = await newPlayer(e2e.app, 'mcp-only');
  const db = e2e.app.container.get(DRIZZLE).db;
  const [role] = await db
    .insert(adminRole)
    .values({ name: `mcp only ${randomUUID()}` })
    .returning({ id: adminRole.id });
  if (!role) {
    throw new Error('role not created');
  }
  await db
    .insert(adminRolePermission)
    .values({ roleId: role.id, resource: 'mcp-access', level: 'read_write' });
  await db.insert(adminRoleAssignment).values({ userId: admin.userId, roleId: role.id });
  await db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.userId));
  return admin;
}

describe('MCP transport gate', () => {
  it('a request without a bearer token is refused with 401 and no-store', async () => {
    const res = await mcpCall(e2e);
    expect(res.status).toBe(401);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(res.res.headers.get('www-authenticate')).toBe('Bearer');
    expect(JsonRpcSchema.parse(res.body).error?.message).toContain('bearer token required');
  });

  it('a request with an invalid or revoked token is refused with 401', async () => {
    const { admin, issued } = await adminToken();
    const forged = await mcpCall(e2e, { token: `${issued.token.slice(0, -4)}AAAA` });
    expect(forged.status).toBe(401);
    expect(forged.res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');

    const accepted = await mcpCall(e2e, { token: issued.token });
    expect(accepted.status).toBe(200);

    const revoke = await admin.client.post(`/iam/my-mcp-tokens/${issued.id}/revoke`);
    expect(revoke.status).toBe(200);
    const refused = await mcpCall(e2e, { token: issued.token });
    expect(refused.status).toBe(401);
    expect((await tokenRow(e2e, issued.id)).revokedAt).not.toBeNull();
  });

  it('a valid token calls a tool and gets a JSON-RPC result', async () => {
    const { issued } = await adminToken();
    const listed = await mcpCall(e2e, { token: issued.token });
    expect(listed.status).toBe(200);
    const names = ToolsListSchema.parse(JsonRpcSchema.parse(listed.body).result).tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('ggr_summary');

    const called = await mcpCall(e2e, { token: issued.token, body: toolsCall('ggr_summary') });
    expect(called.status).toBe(200);
    const result = ToolResultSchema.parse(JsonRpcSchema.parse(called.body).result);
    expect(result.isError).not.toBe(true);
    expect((await tokenRow(e2e, issued.id)).callCount).toBe(1);
  });

  it('a request from an unlisted Origin is refused and a listed Origin gets CORS headers', async () => {
    const { issued } = await adminToken();
    const refused = await mcpCall(e2e, { token: issued.token, origin: 'https://evil.example.com' });
    expect(refused.status).toBe(403);
    expect(refused.res.headers.get('access-control-allow-origin')).toBeNull();

    const allowed = await mcpCall(e2e, { token: issued.token, origin: MCP_TEST_ORIGIN });
    expect(allowed.status).toBe(200);
    expect(allowed.res.headers.get('access-control-allow-origin')).toBe(MCP_TEST_ORIGIN);

    const preflight = await mcpCall(e2e, { method: 'OPTIONS', origin: MCP_TEST_ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.res.headers.get('access-control-allow-origin')).toBe(MCP_TEST_ORIGIN);
  });

  it('a non-POST method is refused with 405', async () => {
    const { issued } = await adminToken();
    const res = await mcpCall(e2e, { token: issued.token, method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.res.headers.get('allow')).toBe('POST');
  });

  it('an oversized body is refused with 413 and a malformed body with a parse error', async () => {
    const { issued } = await adminToken();
    const oversized = await mcpCall(e2e, {
      token: issued.token,
      rawBody: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { pad: 'a'.repeat(1_100_000) },
      }),
    });
    expect(oversized.status).toBe(413);

    const malformed = await mcpCall(e2e, { token: issued.token, rawBody: '{not json' });
    expect(malformed.status).toBe(400);
    expect(JsonRpcSchema.parse(malformed.body).error?.code).toBe(-32700);
  });

  it('a JSON-RPC batch is refused', async () => {
    const { issued } = await adminToken();
    const res = await mcpCall(e2e, { token: issued.token, body: [toolsList(), toolsList()] });
    expect(res.status).toBe(400);
    expect(JsonRpcSchema.parse(res.body).error?.code).toBe(-32600);
  });

  it('a token past its per-minute limit gets 429 with Retry-After and a fresh token is unaffected', async () => {
    const limited = await adminToken();
    const fresh = await adminToken();
    for (let i = 0; i < MCP_TEST_LIMITS.perMinute; i++) {
      expect((await mcpCall(e2e, { token: limited.issued.token })).status).toBe(200);
    }
    const over = await mcpCall(e2e, { token: limited.issued.token });
    expect(over.status).toBe(429);
    expect(Number(over.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    expect((await mcpCall(e2e, { token: fresh.issued.token })).status).toBe(200);
  });

  it('an address past its per-minute limit is refused even with a different valid token', async () => {
    const first = await adminToken();
    const second = await adminToken();
    const ip = `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;
    for (let i = 0; i < MCP_TEST_LIMITS.perIpPerMinute; i++) {
      expect((await mcpCall(e2e, { token: first.issued.token, ip })).status).toBe(200);
    }
    const over = await mcpCall(e2e, { token: second.issued.token, ip });
    expect(over.status).toBe(429);
    expect(over.res.headers.get('retry-after')).not.toBeNull();
    expect((await mcpCall(e2e, { token: second.issued.token })).status).toBe(200);
  });

  it('a token without the permission for a tool gets access denied', async () => {
    const admin = await mcpOnlyAdmin();
    const issued = await issueToken(admin);

    const listed = await mcpCall(e2e, { token: issued.token });
    expect(listed.status).toBe(200);
    const names = ToolsListSchema.parse(JsonRpcSchema.parse(listed.body).result).tools.map(
      (tool) => tool.name,
    );
    expect(names).not.toContain('ggr_summary');

    const called = await mcpCall(e2e, { token: issued.token, body: toolsCall('ggr_summary') });
    expect(called.status).toBe(200);
    const result = ToolResultSchema.parse(JsonRpcSchema.parse(called.body).result);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('forbidden');
  });
});
