import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { mcpToken } from '@openora/core/iam/schema';
import { account } from '@openora/core/pam/schema/identity';
import {
  assignIamRoleByKey,
  bootE2e,
  closeE2e,
  flushAudit,
  newStaff,
  totpCode,
  type E2e,
} from '../index.js';
import {
  ErrorSchema,
  IssuedTokenSchema,
  JsonRpcSchema,
  MCP_PASSWORD,
  RevokeAllSchema,
  TokenListSchema,
  TokenSchema,
  bootMcpE2e,
  issueToken,
  mcpCall,
  newMcpAdmin,
  tokenRow,
} from './support/mcp.js';
import { MCP_TEST_LIMITS } from './support/test-mcp-plugin.js';
import { call, enrolledPlayer, signInWithCode, wrongCode } from './support/two-factor.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootMcpE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

async function auditRows(action: string, resourceId: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

async function tokenCount(adminUserId: string) {
  const rows = await db().select().from(mcpToken).where(eq(mcpToken.adminUserId, adminUserId));
  return rows.length;
}

async function refusedMcp(token: string) {
  const res = await mcpCall(e2e, { token });
  return { status: res.status, body: res.body, www: res.res.headers.get('www-authenticate') };
}

describe('own agent tokens', () => {
  it('an admin creates a token with a ttl within the policy and sees the secret once', async () => {
    const admin = await newMcpAdmin(e2e);
    const res = await admin.client.post('/iam/my-mcp-tokens', {
      label: 'ci agent',
      ttlDays: 7,
      currentPassword: MCP_PASSWORD,
    });
    expect(res.status).toBe(200);
    const issued = IssuedTokenSchema.parse(await res.json());
    expect(issued.status).toBe('active');
    expect(issued.adminUserId).toBe(admin.userId);
    const lifetimeMs = Date.parse(issued.expiresAt) - Date.parse(issued.createdAt);
    expect(lifetimeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(200);

    const row = await tokenRow(e2e, issued.id);
    expect(row.tokenHash).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(Object.values(row)).not.toContain(issued.token);

    const listed = await admin.client.get('/iam/my-mcp-tokens');
    expect(await listed.text()).not.toContain(issued.token);

    const audit = await auditRows('iam.mcp_token.created', issued.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(admin.userId);
    expect(JSON.stringify(audit[0])).not.toContain(issued.token);
  });

  it('a ttl above the policy maximum is refused', async () => {
    const admin = await newMcpAdmin(e2e);
    const over = await admin.client.post('/iam/my-mcp-tokens', {
      label: 'too long',
      ttlDays: MCP_TEST_LIMITS.tokenTtlMaxDays + 1,
      currentPassword: MCP_PASSWORD,
    });
    expect(over.status).toBe(400);
    expect(ErrorSchema.parse(await over.json()).data?.reason).toBe('ttl_exceeds_max');
    expect(await tokenCount(admin.userId)).toBe(0);

    const atMax = await issueToken(admin, { ttlDays: MCP_TEST_LIMITS.tokenTtlMaxDays });
    expect(atMax.status).toBe('active');
  });

  it('creating a token while the feature is disabled is refused', async () => {
    const disabled = await bootE2e();
    try {
      const admin = await newStaff(disabled.app, 'mcp-off', 'admin');
      const res = await admin.client.post('/iam/my-mcp-tokens', {
        label: 'off',
        currentPassword: MCP_PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(ErrorSchema.parse(await res.json()).data?.reason).toBe('mcp_disabled');
      const rows = await disabled.app.container
        .get(DRIZZLE)
        .db.select()
        .from(mcpToken)
        .where(eq(mcpToken.adminUserId, admin.userId));
      expect(rows).toHaveLength(0);
    } finally {
      await closeE2e(disabled);
    }
  }, 60_000);

  it('creation requires a fresh two factor code', async () => {
    const enrolled = await enrolledPlayer(e2e, 'mcp-2fa');
    await assignIamRoleByKey(e2e.app.container, enrolled.userId, 'admin');
    const browser = await signInWithCode(e2e, enrolled);
    const create = (extra: Record<string, unknown>) =>
      call(e2e, browser, 'POST', '/iam/my-mcp-tokens', {
        label: 'two factor',
        currentPassword: enrolled.password,
        ...extra,
      });

    const missing = await create({});
    expect(missing.status).toBe(422);
    expect(ErrorSchema.parse(missing.body).data?.reason).toBe('reauthentication_required');

    const wrong = await create({ totpCode: wrongCode(enrolled.secret) });
    expect(wrong.status).toBe(403);
    expect(ErrorSchema.parse(wrong.body).data?.reason).toBe('reauthentication_failed');
    expect(await tokenCount(enrolled.userId)).toBe(0);

    const fresh = await create({ totpCode: totpCode(enrolled.secret, Date.now() + 30_000) });
    expect(fresh.status).toBe(200);
    expect(await tokenCount(enrolled.userId)).toBe(1);
  });

  it('listing own tokens never returns the secret and shows the display prefix and status', async () => {
    const admin = await newMcpAdmin(e2e);
    const active = await issueToken(admin, { label: 'active one' });
    const revoked = await issueToken(admin, { label: 'revoked one' });
    await admin.client.post(`/iam/my-mcp-tokens/${revoked.id}/revoke`);

    const res = await admin.client.get('/iam/my-mcp-tokens');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(active.token);
    expect(text).not.toContain(revoked.token);
    expect(text).not.toContain('tokenHash');
    const list = TokenListSchema.parse(JSON.parse(text));
    expect(list.total).toBe(2);
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(active.id)).toMatchObject({
      tokenPrefix: active.tokenPrefix,
      status: 'active',
    });
    expect(byId.get(revoked.id)).toMatchObject({
      tokenPrefix: revoked.tokenPrefix,
      status: 'revoked',
    });
    expect(active.token.startsWith(active.tokenPrefix)).toBe(true);
    expect(active.tokenPrefix.length).toBeLessThan(active.token.length);
  });

  it('an admin revokes an own token and the token stops authenticating', async () => {
    const admin = await newMcpAdmin(e2e);
    const issued = await issueToken(admin);
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(200);

    const res = await admin.client.post(`/iam/my-mcp-tokens/${issued.id}/revoke`);
    expect(res.status).toBe(200);
    expect(TokenSchema.parse(await res.json())).toMatchObject({
      status: 'revoked',
      revokeReason: 'manual',
      revokedBy: admin.userId,
    });
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(401);

    const row = await tokenRow(e2e, issued.id);
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokeReason).toBe('manual');
    const audit = await auditRows('iam.mcp_token.revoked', issued.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(admin.userId);
  });

  it('an admin cannot revoke the token of another admin through the own token route', async () => {
    const owner = await newMcpAdmin(e2e);
    const other = await newMcpAdmin(e2e);
    const issued = await issueToken(owner);

    const res = await other.client.post(`/iam/my-mcp-tokens/${issued.id}/revoke`);
    expect(res.status).toBe(404);
    const row = await tokenRow(e2e, issued.id);
    expect(row.revokedAt).toBeNull();
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(200);
    expect(await auditRows('iam.mcp_token.revoked', issued.id)).toHaveLength(0);
  });

  it('revoking an already revoked token keeps the first revoke reason', async () => {
    const owner = await newMcpAdmin(e2e);
    const superAdmin = await newStaff(e2e.app, 'mcp-super', 'super-admin');
    const issued = await issueToken(owner);

    await owner.client.post(`/iam/my-mcp-tokens/${issued.id}/revoke`);
    const first = await tokenRow(e2e, issued.id);

    const again = await superAdmin.client.post(`/iam/mcp-tokens/${issued.id}/revoke`);
    expect(again.status).toBe(200);
    expect(TokenSchema.parse(await again.json()).revokedBy).toBe(owner.userId);
    const second = await tokenRow(e2e, issued.id);
    expect(second.revokedAt).toEqual(first.revokedAt);
    expect(second.revokedBy).toBe(owner.userId);
    expect(second.revokeReason).toBe('manual');
    expect(await auditRows('iam.mcp_token.revoked', issued.id)).toHaveLength(1);
  });
});

describe('token administration', () => {
  it('a super admin lists the tokens of every admin', async () => {
    const first = await newMcpAdmin(e2e);
    const second = await newMcpAdmin(e2e);
    const superAdmin = await newStaff(e2e.app, 'mcp-super', 'super-admin');
    const firstToken = await issueToken(first);
    const secondToken = await issueToken(second);

    const all = await superAdmin.client.get('/iam/mcp-tokens?limit=100');
    expect(all.status).toBe(200);
    const ids = TokenListSchema.parse(await all.json()).items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([firstToken.id, secondToken.id]));

    const scoped = await superAdmin.client.get(`/iam/mcp-tokens?adminUserId=${second.userId}`);
    const scopedList = TokenListSchema.parse(await scoped.json());
    expect(scopedList.items.map((item) => item.id)).toEqual([secondToken.id]);
    expect(scopedList.items[0]?.admin.id).toBe(second.userId);
  });

  it('a super admin revokes one token of another admin and the reason is stored', async () => {
    const owner = await newMcpAdmin(e2e);
    const superAdmin = await newStaff(e2e.app, 'mcp-super', 'super-admin');
    const issued = await issueToken(owner);
    const untouched = await issueToken(owner);

    const res = await superAdmin.client.post(`/iam/mcp-tokens/${issued.id}/revoke`);
    expect(res.status).toBe(200);
    expect(TokenSchema.parse(await res.json())).toMatchObject({
      status: 'revoked',
      revokeReason: 'manual',
      revokedBy: superAdmin.userId,
    });
    const row = await tokenRow(e2e, issued.id);
    expect(row.revokedBy).toBe(superAdmin.userId);
    expect(row.revokeReason).toBe('manual');
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(401);
    expect((await mcpCall(e2e, { token: untouched.token })).status).toBe(200);
    const audit = await auditRows('iam.mcp_token.revoked', issued.id);
    expect(audit.map((row) => row.actorId)).toEqual([superAdmin.userId]);
  });

  it('revoke all ends every active token and records one reason', async () => {
    const first = await newMcpAdmin(e2e);
    const second = await newMcpAdmin(e2e);
    const superAdmin = await newStaff(e2e.app, 'mcp-super', 'super-admin');
    const issued = [await issueToken(first), await issueToken(first), await issueToken(second)];

    const res = await superAdmin.client.post('/iam/mcp-tokens/revoke-all');
    expect(res.status).toBe(200);
    expect(RevokeAllSchema.parse(await res.json()).revoked).toBeGreaterThanOrEqual(3);

    for (const token of issued) {
      const row = await tokenRow(e2e, token.id);
      expect(row.revokeReason).toBe('revoked_all');
      expect(row.revokedBy).toBe(superAdmin.userId);
      expect((await mcpCall(e2e, { token: token.token })).status).toBe(401);
    }
    const stillActive = await db()
      .select({ id: mcpToken.id })
      .from(mcpToken)
      .where(and(isNull(mcpToken.revokedAt), gt(mcpToken.expiresAt, new Date())));
    expect(stillActive).toHaveLength(0);
  });

  it('a non super admin is refused on the administration routes', async () => {
    const owner = await newMcpAdmin(e2e);
    const manager = await newStaff(e2e.app, 'mcp-manager', 'casino-manager');
    const issued = await issueToken(owner);

    const list = await manager.client.get('/iam/mcp-tokens');
    const revoke = await manager.client.post(`/iam/mcp-tokens/${issued.id}/revoke`);
    const revokeAll = await manager.client.post('/iam/mcp-tokens/revoke-all');
    expect([list.status, revoke.status, revokeAll.status]).toEqual([403, 403, 403]);
    expect((await tokenRow(e2e, issued.id)).revokedAt).toBeNull();
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(200);
  });

  it('a token issued before the admin changed their password is refused as credentials changed', async () => {
    const admin = await newMcpAdmin(e2e);
    const issued = await issueToken(admin);
    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(200);

    await db()
      .update(account)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(and(eq(account.userId, admin.userId), eq(account.providerId, 'credential')));

    expect((await mcpCall(e2e, { token: issued.token })).status).toBe(401);
    expect((await tokenRow(e2e, issued.id)).revokedAt).toBeNull();
  });

  it('an expired token is refused with the expired reason', async () => {
    const admin = await newMcpAdmin(e2e);
    const issued = await issueToken(admin);
    await db()
      .update(mcpToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpToken.id, issued.id));

    const res = await mcpCall(e2e, { token: issued.token });
    expect(res.status).toBe(401);
    const listed = await admin.client.get('/iam/my-mcp-tokens?status=expired');
    const items = TokenListSchema.parse(await listed.json()).items;
    expect(items.map((item) => [item.id, item.status])).toEqual([[issued.id, 'expired']]);
  });

  it('an unknown token is refused without revealing whether it ever existed', async () => {
    const admin = await newMcpAdmin(e2e);
    const issued = await issueToken(admin);
    await admin.client.post(`/iam/my-mcp-tokens/${issued.id}/revoke`);
    const never = `${issued.token.slice(0, -6)}ZZZZZZ`;

    const revoked = await refusedMcp(issued.token);
    const unknown = await refusedMcp(never);
    expect(unknown).toEqual(revoked);
    expect(unknown.status).toBe(401);
    expect(JsonRpcSchema.parse(unknown.body).error?.message).toBe('Unauthorized: invalid token');
  });
});
