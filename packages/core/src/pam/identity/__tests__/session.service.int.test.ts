import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  McpTransportConfigSchema,
  type McpTokenRevocation,
  type User,
} from '@openora/core/contracts';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user, session } from '@openora/core/pam/schema/identity';
import { migrate as migrateIam } from '@openora/core/iam/migrate';
import { mcpToken } from '@openora/core/iam/schema';
import { McpTokenService } from '@openora/core/iam/server';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeRateLimiter,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { SessionService, SessionNotFoundError } from '../service/session.service.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const META = { ip: '203.0.113.7', userAgent: 'backoffice/1.0' };
const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDb;

const service = (mcpTokens?: McpTokenRevocation, events = makeEventBus()) =>
  new SessionService({
    drizzle: db.drizzle,
    events,
    identityReader: makeIdentityReader(),
    mcpTokens,
  });

function makeMcpTokenRevocation() {
  const revokeAllForUser = vi.fn(async () => ({ revoked: 0 }));
  return { port: mock<McpTokenRevocation>({ revokeAllForUser }), revokeAllForUser };
}

function makeMcpTokenService() {
  const audit = makeAuditWriter();
  const tokens = new McpTokenService({
    drizzle: db.drizzle,
    audit,
    events: makeEventBus(),
    rateLimiter: makeRateLimiter(),
    config: McpTransportConfigSchema.parse({}),
  });
  return { tokens, audit, revokeAllForUser: vi.spyOn(tokens, 'revokeAllForUser') };
}

async function seedActiveToken(adminUserId: User['id']) {
  const [row] = await db.drizzle.db
    .insert(mcpToken)
    .values({
      adminUserId,
      label: 'Laptop',
      tokenHash: randomUUID(),
      tokenPrefix: 'ora_mcp_test',
      expiresAt: new Date(Date.now() + DAY_MS),
    })
    .returning({ id: mcpToken.id });
  if (!row) {
    throw new Error('seedActiveToken: insert returned no row');
  }
  return row.id;
}

async function revocationOf(tokenId: string) {
  const [row] = await db.drizzle.db
    .select({
      revokedAt: mcpToken.revokedAt,
      revokedBy: mcpToken.revokedBy,
      revokeReason: mcpToken.revokeReason,
    })
    .from(mcpToken)
    .where(eq(mcpToken.id, tokenId));
  return row;
}

async function activeSessionCount(userId: User['id']) {
  const { total } = await service().listSessions({ userId, activeOnly: true, page: 1, limit: 20 });
  return total;
}

const seedSession = (userId: string, overrides: Partial<typeof session.$inferInsert> = {}) =>
  db.drizzle.db
    .insert(session)
    .values({
      userId,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning()
    .then(([row]) => row!);

beforeAll(async () => {
  db = await createTestDb([migrate, migrateIam]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.execute(sql`TRUNCATE ${mcpToken}, ${user} RESTART IDENTITY CASCADE`);
});

describe('SessionService', () => {
  it('flags only the caller session as current', async () => {
    const account = await seedUser(db);
    const here = await seedSession(account.id);
    await seedSession(account.id);

    const { items } = await service().listSessions({
      userId: account.id,
      currentSessionId: here.id,
      page: 1,
      limit: 20,
    });

    expect(items).toHaveLength(2);
    expect(items.filter((s) => s.current).map((s) => s.id)).toEqual([here.id]);
  });

  it('drops a revoked session from the active list', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id);
    await seedSession(account.id);

    await service().revokeSession(account.id, target.id);

    const active = await service().listSessions({
      userId: account.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });
    expect(active.total).toBe(1);
    expect(active.items.map((s) => s.id)).not.toContain(target.id);
  });

  it('expires the revoked session', async () => {
    const account = await seedUser(db);
    const target = await seedSession(account.id);

    await service().revokeSession(account.id, target.id);

    const { items } = await service().listSessions({ userId: account.id, page: 1, limit: 20 });
    // revokeSession stamps expiresAt with the database clock, so read the same clock back:
    // an app-side Date.now() a millisecond behind the database would fail this on nothing.
    const { rows } = await db.drizzle.db.execute<{ now: string }>(sql`select now() as now`);
    expect(new Date(items[0]!.expiresAt).getTime()).toBeLessThanOrEqual(
      new Date(rows[0]!.now).getTime(),
    );
  });

  it('keeps the last-used timestamp when a session is revoked', async () => {
    const account = await seedUser(db);
    const lastUsed = new Date(Date.now() - 3_600_000);
    const target = await seedSession(account.id, { updatedAt: lastUsed });

    await service().revokeSession(account.id, target.id);

    const { items } = await service().listSessions({ userId: account.id, page: 1, limit: 20 });
    expect(new Date(items[0]!.updatedAt).getTime()).toBe(lastUsed.getTime());
  });

  it('refuses to revoke a session owned by someone else', async () => {
    const owner = await seedUser(db);
    const stranger = await seedUser(db);
    const target = await seedSession(owner.id);

    await expect(service().revokeSession(stranger.id, target.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('drops a player session idled past its own window from the active list, even though it has not expired yet', async () => {
    const account = await seedUser(db);
    await db.drizzle.db
      .update(user)
      .set({ autoLogoutDuration: '15m' })
      .where(eq(user.id, account.id));
    const idled = await seedSession(account.id, { lastSeenAt: minutesAgo(20) });
    const fresh = await seedSession(account.id, { lastSeenAt: minutesAgo(1) });

    const active = await service().listSessions({
      userId: account.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });

    expect(active.items.map((s) => s.id)).toEqual([fresh.id]);
    expect(active.items.map((s) => s.id)).not.toContain(idled.id);
  });

  it('does not idle out an admin session, which has no auto-logout window of its own', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const target = await seedSession(admin.id, { lastSeenAt: minutesAgo(60 * 24 * 30) });

    const active = await service().listSessions({
      userId: admin.id,
      activeOnly: true,
      page: 1,
      limit: 20,
    });

    expect(active.items.map((s) => s.id)).toContain(target.id);
  });

  it('excludes an idled-out player session from the platform-wide active list', async () => {
    const account = await seedUser(db);
    await db.drizzle.db
      .update(user)
      .set({ autoLogoutDuration: '15m' })
      .where(eq(user.id, account.id));
    const idled = await seedSession(account.id, { lastSeenAt: minutesAgo(20) });

    const { items } = await service().listAllActiveSessions({ page: 1, limit: 20 });

    expect(items.map((s) => s.id)).not.toContain(idled.id);
  });
});

describe('SessionService.revokeAllSessions and MCP tokens', () => {
  it("revokes an admin's MCP tokens as sessions_revoked inside the sessions' transaction", async () => {
    const { tokens, revokeAllForUser } = makeMcpTokenService();
    const admin = await seedUser(db, { role: 'admin' });
    await seedSession(admin.id);
    const tokenId = await seedActiveToken(admin.id);
    const actorId = randomUUID();

    await service(tokens).revokeAllSessions(admin.id, actorId, META);

    expect(revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(revokeAllForUser).toHaveBeenCalledWith(
      { userId: admin.id, reason: 'sessions_revoked', actorId, ...META },
      expect.anything(),
    );
    expect(await revocationOf(tokenId)).toEqual({
      revokedAt: expect.any(Date),
      revokedBy: actorId,
      revokeReason: 'sessions_revoked',
    });
    expect(await activeSessionCount(admin.id)).toBe(0);
  });

  it('passes a null actor and no client details for a revoke nobody initiated', async () => {
    const { port, revokeAllForUser } = makeMcpTokenRevocation();
    const admin = await seedUser(db, { role: 'admin' });

    await service(port).revokeAllSessions(admin.id);

    expect(revokeAllForUser).toHaveBeenCalledWith(
      {
        userId: admin.id,
        reason: 'sessions_revoked',
        actorId: null,
        ip: null,
        userAgent: null,
      },
      expect.anything(),
    );
  });

  it('rolls the sessions back when the token revocation fails, and a retry revokes both', async () => {
    const { tokens, audit } = makeMcpTokenService();
    audit.recordManyInTransaction.mockRejectedValueOnce(new Error('audit store unavailable'));
    const events = makeEventBus();
    const admin = await seedUser(db, { role: 'admin' });
    await seedSession(admin.id);
    await seedSession(admin.id);
    const tokenId = await seedActiveToken(admin.id);

    await expect(service(tokens, events).revokeAllSessions(admin.id, randomUUID())).rejects.toThrow(
      'audit store unavailable',
    );

    expect(await activeSessionCount(admin.id)).toBe(2);
    expect(await revocationOf(tokenId)).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(events.emit).not.toHaveBeenCalled();

    await service(tokens, events).revokeAllSessions(admin.id, randomUUID());

    expect(await activeSessionCount(admin.id)).toBe(0);
    expect(await revocationOf(tokenId)).toMatchObject({ revokeReason: 'sessions_revoked' });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.sessions.revoked_all',
      expect.objectContaining({ userId: admin.id }),
    );
  });

  it("revokes a player's sessions without touching the token port", async () => {
    const { port, revokeAllForUser } = makeMcpTokenRevocation();
    const events = makeEventBus();
    const player = await seedUser(db, { role: 'player' });
    await seedSession(player.id);

    await service(port, events).revokeAllSessions(player.id, randomUUID(), META);

    expect(revokeAllForUser).not.toHaveBeenCalled();
    expect(await activeSessionCount(player.id)).toBe(0);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.sessions.revoked_all',
      expect.objectContaining({ userId: player.id, ...META }),
    );
  });
});

describe('SessionService.revokeMcpTokens', () => {
  it("revokes an admin's MCP tokens as sessions_revoked and leaves the sessions alone", async () => {
    const { tokens, revokeAllForUser } = makeMcpTokenService();
    const admin = await seedUser(db, { role: 'admin' });
    await seedSession(admin.id);
    const tokenId = await seedActiveToken(admin.id);

    await service(tokens).revokeMcpTokens(admin.id, admin.id, META);

    expect(revokeAllForUser).toHaveBeenCalledWith({
      userId: admin.id,
      reason: 'sessions_revoked',
      actorId: admin.id,
      ...META,
    });
    expect(await revocationOf(tokenId)).toMatchObject({
      revokedBy: admin.id,
      revokeReason: 'sessions_revoked',
    });
    expect(await activeSessionCount(admin.id)).toBe(1);
  });

  it('never touches the token port for a player', async () => {
    const { port, revokeAllForUser } = makeMcpTokenRevocation();
    const player = await seedUser(db, { role: 'player' });

    await service(port).revokeMcpTokens(player.id, player.id, META);

    expect(revokeAllForUser).not.toHaveBeenCalled();
  });
});
