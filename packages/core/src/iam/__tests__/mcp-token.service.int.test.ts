import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ORPCError } from '@orpc/server';
import { RedisRateLimiter } from '@openora/core/server';
import {
  McpTransportConfigSchema,
  type AuditWritePort,
  type McpTransportConfig,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';
import {
  createTestDb,
  createTestRedis,
  seedUser,
  waitForRowLockWaiter,
  waitForTableLockWaiter,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { session, user, type Session, type User } from '@openora/core/pam/schema/identity';
import { makeAuditWriter, makeEventBus, makeRateLimiter, mock } from '../../testing/mock.js';
import { migrate as migrateIam } from '../migrate.js';
import { mcpToken } from '../schema/index.js';
import {
  IssuedMcpTokenSchema,
  McpTokenListItemSchema,
  McpTokenSchema,
  type CreateMcpTokenInput,
} from '../contract/index.js';
import {
  McpTokenIssueError,
  McpTokenLimitError,
  McpTokenNotFoundError,
  McpTokenOwnerIneligibleError,
  McpTokenService,
  McpTokenTtlError,
  McpTransportDisabledError,
} from '../service/mcp-token.service.js';
import {
  generateMcpToken,
  hashMcpToken,
  isMcpTokenFormat,
  mcpTokenDisplayPrefix,
} from '../shared/mcp-token.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const META = { ip: '203.0.113.7', userAgent: 'mcp-client/1.0' };
const PAGE = { page: 1, limit: 50 };
const BACKOFFICE_HOSTS = ['backoffice.example.com'];
const ENABLED = McpTransportConfigSchema.parse({
  enabled: true,
  allowedHosts: BACKOFFICE_HOSTS,
  tokenTtlDays: { default: 30, max: 90 },
});
const DISABLED = McpTransportConfigSchema.parse({});

const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

const withIssuance = (tokenIssuance: { maxActivePerAdmin?: number; perHour?: number }) =>
  McpTransportConfigSchema.parse({ enabled: true, allowedHosts: BACKOFFICE_HOSTS, tokenIssuance });

let db: TestDb;
let redis: TestRedis;

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${mcpToken}, ${user} RESTART IDENTITY CASCADE`);
  await redis.flush();
});

function makeService({
  config = ENABLED,
  rateLimiter = makeRateLimiter(),
}: { config?: McpTransportConfig; rateLimiter?: RateLimiterAdapter<RateLimitKey> } = {}) {
  const audit = makeAuditWriter();
  const events = makeEventBus();
  return {
    svc: new McpTokenService({
      drizzle: db.drizzle,
      audit,
      events,
      rateLimiter,
      config,
      now: () => NOW,
    }),
    audit,
    events,
  };
}

async function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

async function seedSession(userId: User['id'], expiresAt = new Date(Date.now() + DAY_MS)) {
  const [row] = await db.drizzle.db
    .insert(session)
    .values({ userId, token: randomUUID(), expiresAt, updatedAt: new Date() })
    .returning({ id: session.id });
  if (!row) {
    throw new Error('seedSession: insert returned no row');
  }
  return row.id;
}

async function withSession(owner: User) {
  return { ...owner, sessionId: await seedSession(owner.id) };
}

const seedAdmin = async (email: string, name = 'Admin') =>
  withSession(await seedUser(db, { email, name, role: 'admin', isActive: true }));

const issueAs = (
  svc: McpTokenService,
  owner: { id: User['id']; sessionId: Session['id'] },
  input: CreateMcpTokenInput,
) => svc.create({ ...input, adminUserId: owner.id, sessionId: owner.sessionId }, META);

async function seedToken(adminUserId: string, over: Partial<typeof mcpToken.$inferInsert> = {}) {
  const token = generateMcpToken();
  const [row] = await db.drizzle.db
    .insert(mcpToken)
    .values({
      adminUserId,
      label: 'Laptop',
      tokenHash: hashMcpToken(token),
      tokenPrefix: mcpTokenDisplayPrefix(token),
      createdAt: NOW,
      expiresAt: daysFromNow(30),
      ...over,
    })
    .returning();
  return row;
}

async function storedToken(id: string) {
  const [row] = await db.drizzle.db.select().from(mcpToken).where(eq(mcpToken.id, id));
  return row;
}

type AuditEntry = Parameters<AuditWritePort['recordInTransaction']>[1];

const auditEntries = (audit: ReturnType<typeof makeAuditWriter>): AuditEntry[] => [
  ...audit.recordInTransaction.mock.calls.map((call) => call[1]),
  ...audit.recordManyInTransaction.mock.calls.flatMap((call) => call[1]),
];

describe('McpTokenService.create (real PG)', () => {
  it('stores only the hash and a display prefix and hands the plaintext back once', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    const issued = await issueAs(svc, alice, { label: 'Claude Code' });

    expect(isMcpTokenFormat(issued.token)).toBe(true);
    const row = await storedToken(issued.id);
    expect(row).toMatchObject({
      adminUserId: alice.id,
      label: 'Claude Code',
      tokenHash: hashMcpToken(issued.token),
      tokenPrefix: issued.token.slice(0, 12),
      callCount: 0,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(Object.values(row)).not.toContain(issued.token);
    expect(IssuedMcpTokenSchema.parse(issued)).toEqual(issued);
    expect(issued).not.toHaveProperty('tokenHash');
    expect(issued).toMatchObject({ status: 'active', tokenPrefix: row.tokenPrefix });
    const listed = await svc.listMine(alice.id, PAGE);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
  });

  it('expires the token the configured default number of days after issue', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    const issued = await issueAs(svc, alice, { label: 'Default' });

    expect((await storedToken(issued.id)).expiresAt).toEqual(daysFromNow(30));
    expect(issued.createdAt).toBe(NOW.toISOString());
    expect(issued.expiresAt).toBe(daysFromNow(30).toISOString());
  });

  it('honours a requested lifetime up to the configured maximum', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    const week = await issueAs(svc, alice, { label: 'Week', ttlDays: 7 });
    const longest = await issueAs(svc, alice, { label: 'Max', ttlDays: 90 });

    expect((await storedToken(week.id)).expiresAt).toEqual(daysFromNow(7));
    expect((await storedToken(longest.id)).expiresAt).toEqual(daysFromNow(90));
  });

  it('refuses a lifetime above the configured maximum as ttl_exceeds_max and stores nothing', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    const refusal = await rejectionOf(issueAs(svc, alice, { label: 'Too long', ttlDays: 91 }));

    expect(refusal).toBeInstanceOf(McpTokenTtlError);
    expect(refusal).toHaveProperty('data', { reason: 'ttl_exceeds_max' });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('refuses to issue while the transport is disabled, as mcp_disabled', async () => {
    const { svc, audit } = makeService({ config: DISABLED });
    const alice = await seedAdmin('alice@ops.example');

    const refusal = await rejectionOf(issueAs(svc, alice, { label: 'Claude Code' }));

    expect(refusal).toBeInstanceOf(McpTransportDisabledError);
    expect(refusal).toHaveProperty('data', { reason: 'mcp_disabled' });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('audits the issue on the creating transaction without the token or its hash', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    const issued = await issueAs(svc, alice, { label: 'Claude Code' });

    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(expect.anything(), {
      actorId: alice.id,
      actorType: 'admin',
      action: 'iam.mcp_token.created',
      resourceType: 'mcp-token',
      resourceId: issued.id,
      after: {
        adminUserId: alice.id,
        label: 'Claude Code',
        tokenPrefix: issued.tokenPrefix,
        expiresAt: daysFromNow(30).toISOString(),
        ttlDays: 30,
      },
      ...META,
    });
    const recorded = JSON.stringify(auditEntries(audit));
    expect(recorded).not.toContain(issued.token);
    expect(recorded).not.toContain(hashMcpToken(issued.token));
  });

  it('rolls the token back when its audit record cannot be written, failing generically', async () => {
    const { svc, audit } = makeService();
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit store unavailable'));
    const alice = await seedAdmin('alice@ops.example');

    const failure = await rejectionOf(issueAs(svc, alice, { label: 'Claude Code' }));

    expect(failure).toBeInstanceOf(McpTokenIssueError);
    expect(failure).not.toHaveProperty('cause');
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });
});

describe('McpTokenService.create owner checks (real PG)', () => {
  it.each([
    [
      'an inactive admin',
      async () => withSession(await seedUser(db, { role: 'admin', isActive: false })),
      'admin',
    ],
    ['a player', async () => withSession(await seedUser(db, { role: 'player' })), 'player'],
    [
      'a staff account whose role grants no MCP access',
      async () => withSession(await seedUser(db, { role: 'support' })),
      'support',
    ],
  ])('refuses %s as owner_ineligible and records the denial', async (_case, seed, role) => {
    const { svc, audit, events } = makeService();
    const owner = await seed();

    const refusal = await rejectionOf(issueAs(svc, owner, { label: 'Nope' }));

    expect(refusal).toBeInstanceOf(McpTokenOwnerIneligibleError);
    expect(refusal).toHaveProperty('data', { reason: 'owner_ineligible' });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('identity.user.unauthorized_access', {
      userId: owner.id,
      playerId: null,
      resource: 'mcp-access',
      action: 'use',
      role,
      ...META,
    });
  });

  it('refuses an owner with no account as owner_ineligible', async () => {
    const { svc, events } = makeService();
    const ghostId = randomUUID();

    await expect(
      svc.create({ adminUserId: ghostId, sessionId: null, label: 'Nope' }, META),
    ).rejects.toBeInstanceOf(McpTokenOwnerIneligibleError);

    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId: ghostId, role: undefined }),
    );
  });
});

describe('McpTokenService.create session check (real PG)', () => {
  const ENDED_SESSIONS: [string, (ownerId: User['id']) => Promise<Session['id'] | null>][] = [
    ['has expired', (ownerId) => seedSession(ownerId, new Date(Date.now() - HOUR_MS))],
    ['was deleted', async () => randomUUID()],
    ['belongs to another admin', async () => (await seedAdmin('other@ops.example')).sessionId],
    ['the request did not carry', async () => null],
  ];

  it.each(ENDED_SESSIONS)(
    'refuses an issue from a session that %s, as owner_ineligible, and records the denial',
    async (_case, sessionOf) => {
      const { svc, audit, events } = makeService();
      const alice = await seedAdmin('alice@ops.example');

      const refusal = await rejectionOf(
        svc.create(
          { adminUserId: alice.id, sessionId: await sessionOf(alice.id), label: 'Stale' },
          META,
        ),
      );

      expect(refusal).toBeInstanceOf(McpTokenOwnerIneligibleError);
      expect(refusal).toHaveProperty('data', { reason: 'owner_ineligible' });
      expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith('identity.user.unauthorized_access', {
        userId: alice.id,
        playerId: null,
        resource: 'mcp-access',
        action: 'use',
        role: 'admin',
        ...META,
      });
    },
  );

  it('refuses an issue whose session was revoked while it waited, though its transaction began first', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    let releaseOwner = () => {};
    let markOwnerHeld = () => {};
    const ownerHeld = new Promise<void>((resolve) => {
      markOwnerHeld = resolve;
    });
    const holdingOwner = db.drizzle.db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, alice.id)).for('update');
      markOwnerHeld();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await ownerHeld;

    const issuing = rejectionOf(issueAs(svc, alice, { label: 'Waited' }));
    await waitForRowLockWaiter(db);
    await db.drizzle.db.transaction((tx) =>
      tx
        .update(session)
        .set({ expiresAt: sql`now()` })
        .where(eq(session.id, alice.sessionId)),
    );
    releaseOwner();
    await holdingOwner;

    expect(await issuing).toBeInstanceOf(McpTokenOwnerIneligibleError);
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  it('issues from a live session of the owner', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    await expect(issueAs(svc, alice, { label: 'Live' })).resolves.toMatchObject({
      adminUserId: alice.id,
      status: 'active',
    });
  });
});

describe('McpTokenService.create active-token cap (real PG)', () => {
  it('refuses a token over the cap as token_limit, counting neither expired nor revoked ones', async () => {
    const { svc } = makeService({ config: withIssuance({ maxActivePerAdmin: 2 }) });
    const alice = await seedAdmin('alice@ops.example');
    const [first] = [await seedToken(alice.id), await seedToken(alice.id)];
    await seedToken(alice.id, { expiresAt: daysFromNow(-1) });
    await seedToken(alice.id, { revokedAt: daysFromNow(-1), revokeReason: 'manual' });

    const refusal = await rejectionOf(issueAs(svc, alice, { label: 'Third' }));

    expect(refusal).toBeInstanceOf(McpTokenLimitError);
    expect(refusal).toHaveProperty('data', { reason: 'token_limit' });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(4);

    await svc.revokeMine(alice.id, first.id, META);
    await expect(issueAs(svc, alice, { label: 'Replacement' })).resolves.toMatchObject({
      status: 'active',
    });
  });

  it("counts only the owner's own tokens", async () => {
    const { svc } = makeService({ config: withIssuance({ maxActivePerAdmin: 1 }) });
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    await seedToken(bob.id);

    await expect(issueAs(svc, alice, { label: 'Own' })).resolves.toMatchObject({
      adminUserId: alice.id,
    });
  });

  it('holds a concurrent issue until the first commits, then refuses it at the cap', async () => {
    let markCounted = () => {};
    let releaseFirst = () => {};
    const counted = new Promise<void>((resolve) => {
      markCounted = resolve;
    });
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const consume = vi.fn(async () => ({ allowed: true, retryAfterMs: 0 }));
    consume.mockImplementationOnce(async () => {
      markCounted();
      await firstHeld;
      return { allowed: true, retryAfterMs: 0 };
    });
    const { svc } = makeService({
      config: withIssuance({ maxActivePerAdmin: 1 }),
      rateLimiter: mock<RateLimiterAdapter<RateLimitKey>>({ consume, reset: vi.fn() }),
    });
    const alice = await seedAdmin('alice@ops.example');

    const first = issueAs(svc, alice, { label: 'First' });
    await counted;
    const second = rejectionOf(issueAs(svc, alice, { label: 'Second' }));
    await waitForRowLockWaiter(db);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ label: 'First' });
    expect(await second).toBeInstanceOf(McpTokenLimitError);
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(1);
  });
});

describe('McpTokenService.create issuance throttle', () => {
  it('refuses the issue over the hourly limit with TOO_MANY_REQUESTS and its retry delay', async () => {
    const { svc } = makeService({
      config: withIssuance({ perHour: 2 }),
      rateLimiter: new RedisRateLimiter(redis.client),
    });
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    await issueAs(svc, alice, { label: 'One' });
    await issueAs(svc, alice, { label: 'Two' });

    const refusal = await rejectionOf(issueAs(svc, alice, { label: 'Three' }));

    expect(refusal).toBeInstanceOf(ORPCError);
    expect(refusal).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(refusal).toHaveProperty(
      'data.retryAfterMs',
      expect.toSatisfy((ms: number) => ms > 0 && ms <= HOUR_MS),
    );
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(2);
    await expect(issueAs(svc, bob, { label: 'Bob' })).resolves.toMatchObject({
      adminUserId: bob.id,
    });
  });

  it('throttles per admin for an hour and fails closed when the limiter store is down', async () => {
    const consume = vi.fn(async () => ({
      allowed: false,
      retryAfterMs: HOUR_MS,
      unavailable: true,
    }));
    const { svc, audit } = makeService({
      config: withIssuance({ perHour: 7 }),
      rateLimiter: mock<RateLimiterAdapter<RateLimitKey>>({ consume, reset: vi.fn() }),
    });
    const alice = await seedAdmin('alice@ops.example');

    await expect(issueAs(svc, alice, { label: 'Blocked' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: HOUR_MS },
    });

    expect(consume).toHaveBeenCalledWith(`mcp-token-create:${alice.id}`, {
      limit: 7,
      windowMs: HOUR_MS,
      onUnavailable: 'deny',
    });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
});

describe('McpTokenService.revokeMine (real PG)', () => {
  it("revokes the caller's own token as a manual revoke and audits it once", async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);

    const revoked = await svc.revokeMine(alice.id, token.id, META);

    expect(McpTokenSchema.parse(revoked)).toEqual(revoked);
    expect(revoked).toMatchObject({
      id: token.id,
      status: 'revoked',
      revokedAt: NOW.toISOString(),
      revokedBy: alice.id,
      revokeReason: 'manual',
    });
    expect(await storedToken(token.id)).toMatchObject({
      revokedAt: NOW,
      revokedBy: alice.id,
      revokeReason: 'manual',
    });
    expect(auditEntries(audit)).toEqual([
      {
        actorId: alice.id,
        actorType: 'admin',
        action: 'iam.mcp_token.revoked',
        resourceType: 'mcp-token',
        resourceId: token.id,
        before: { revokedAt: null },
        after: {
          adminUserId: alice.id,
          label: token.label,
          tokenPrefix: token.tokenPrefix,
          reason: 'manual',
        },
        ...META,
      },
    ]);
  });

  it("answers another admin's token as not found and leaves it active", async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    const bobsToken = await seedToken(bob.id);

    await expect(svc.revokeMine(alice.id, bobsToken.id, META)).rejects.toBeInstanceOf(
      McpTokenNotFoundError,
    );

    expect(await storedToken(bobsToken.id)).toMatchObject({ revokedAt: null, revokedBy: null });
    expect(auditEntries(audit)).toEqual([]);
  });

  it('answers an unknown token id as not found', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');

    await expect(svc.revokeMine(alice.id, randomUUID(), META)).rejects.toBeInstanceOf(
      McpTokenNotFoundError,
    );
  });

  it('returns an already revoked token unchanged and writes no second audit record', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);

    const first = await svc.revokeMine(alice.id, token.id, META);
    const second = await svc.revokeMine(alice.id, token.id, META);

    expect(second).toEqual(first);
    expect(auditEntries(audit)).toHaveLength(1);
  });
});

describe('McpTokenService concurrent revocation (real PG)', () => {
  it('revokes once and audits once when an owner and an overseer revoke together', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const overseer = await seedAdmin('overseer@ops.example');
    const token = await seedToken(alice.id);

    const [mine, overseen, all] = await Promise.all([
      svc.revokeMine(alice.id, token.id, META),
      svc.revoke(token.id, overseer.id, META),
      svc.revokeAll(overseer.id, META),
    ]);

    const [winner] = auditEntries(audit);
    expect(auditEntries(audit)).toHaveLength(1);
    expect(overseen).toEqual(mine);
    expect(mine).toMatchObject({ status: 'revoked', revokeReason: winner?.after?.['reason'] });
    expect(all.revoked).toBe(winner?.after?.['reason'] === 'revoked_all' ? 1 : 0);
  });
});

describe('McpTokenService.revoke (real PG)', () => {
  it("revokes any admin's token in the overseer's name, once", async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const overseer = await seedAdmin('overseer@ops.example');
    const token = await seedToken(alice.id);

    const revoked = await svc.revoke(token.id, overseer.id, META);
    const repeated = await svc.revoke(token.id, overseer.id, META);

    expect(revoked).toMatchObject({
      status: 'revoked',
      adminUserId: alice.id,
      revokedBy: overseer.id,
      revokeReason: 'manual',
    });
    expect(repeated).toEqual(revoked);
    expect(auditEntries(audit)).toEqual([
      expect.objectContaining({ actorId: overseer.id, actorType: 'admin', resourceId: token.id }),
    ]);
  });

  it('answers an unknown token id as not found', async () => {
    const { svc } = makeService();
    const overseer = await seedAdmin('overseer@ops.example');

    await expect(svc.revoke(randomUUID(), overseer.id, META)).rejects.toBeInstanceOf(
      McpTokenNotFoundError,
    );
  });
});

describe('McpTokenService.revokeAll (real PG)', () => {
  it('revokes every active token, skips expired and revoked ones, and audits each', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    const overseer = await seedAdmin('overseer@ops.example');
    const active = [await seedToken(alice.id), await seedToken(alice.id), await seedToken(bob.id)];
    const expired = await seedToken(alice.id, { expiresAt: daysFromNow(-1) });
    const earlierRevokedAt = daysFromNow(-2);
    const alreadyRevoked = await seedToken(bob.id, {
      revokedAt: earlierRevokedAt,
      revokedBy: bob.id,
      revokeReason: 'manual',
    });

    const result = await svc.revokeAll(overseer.id, META);

    expect(result).toEqual({ revoked: 3 });
    for (const token of active) {
      expect(await storedToken(token.id)).toMatchObject({
        revokedAt: NOW,
        revokedBy: overseer.id,
        revokeReason: 'revoked_all',
      });
    }
    expect(await storedToken(expired.id)).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(await storedToken(alreadyRevoked.id)).toMatchObject({
      revokedAt: earlierRevokedAt,
      revokedBy: bob.id,
      revokeReason: 'manual',
    });
    const entries = auditEntries(audit);
    expect(audit.recordManyInTransaction).toHaveBeenCalledTimes(1);
    expect(entries.map((entry) => entry.resourceId).sort()).toEqual(
      active.map((token) => token.id).sort(),
    );
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actorId: overseer.id,
        actorType: 'admin',
        action: 'iam.mcp_token.revoked',
        after: { reason: 'revoked_all' },
      });
    }
  });
});

describe('McpTokenService.revokeAllForUser (real PG)', () => {
  it("revokes only that user's active tokens with the given reason and actor", async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    const overseer = await seedAdmin('overseer@ops.example');
    const alicesTokens = [await seedToken(alice.id), await seedToken(alice.id)];
    const bobsToken = await seedToken(bob.id);

    const result = await svc.revokeAllForUser({
      userId: alice.id,
      reason: 'admin_disabled',
      actorId: overseer.id,
      ...META,
    });

    expect(result).toEqual({ revoked: 2 });
    for (const token of alicesTokens) {
      expect(await storedToken(token.id)).toMatchObject({
        revokedAt: NOW,
        revokedBy: overseer.id,
        revokeReason: 'admin_disabled',
      });
    }
    expect(await storedToken(bobsToken.id)).toMatchObject({ revokedAt: null });
    expect(auditEntries(audit)).toHaveLength(2);
    for (const entry of auditEntries(audit)) {
      expect(entry).toMatchObject({
        actorId: overseer.id,
        actorType: 'admin',
        after: { adminUserId: alice.id, reason: 'admin_disabled' },
        ...META,
      });
    }
  });

  it('records a revocation with no actor as a system revocation', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);

    await svc.revokeAllForUser({ userId: alice.id, reason: 'sessions_revoked', actorId: null });

    expect(await storedToken(token.id)).toMatchObject({
      revokedBy: null,
      revokeReason: 'sessions_revoked',
    });
    expect(auditEntries(audit)).toEqual([
      expect.objectContaining({
        actorId: null,
        actorType: 'system',
        ip: null,
        userAgent: null,
        after: expect.objectContaining({ reason: 'sessions_revoked' }),
      }),
    ]);
  });

  it('revokes nothing and writes no audit record for a user without active tokens', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    await seedToken(alice.id, { expiresAt: daysFromNow(-1) });

    const result = await svc.revokeAllForUser({
      userId: alice.id,
      reason: 'admin_role_removed',
      actorId: null,
    });

    expect(result).toEqual({ revoked: 0 });
    expect(auditEntries(audit)).toEqual([]);
  });
});

describe('McpTokenService.list and listMine (real PG)', () => {
  it("lists only the caller's tokens in listMine, each with its owning admin", async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example', 'Alice');
    const bob = await seedAdmin('bob@ops.example', 'Bob');
    await seedToken(alice.id);
    await seedToken(alice.id);
    await seedToken(bob.id);

    const result = await svc.listMine(alice.id, PAGE);

    expect(paginated(McpTokenListItemSchema).parse(result)).toEqual(result);
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item).not.toHaveProperty('tokenHash');
      expect(item).toMatchObject({
        adminUserId: alice.id,
        status: 'active',
        admin: { id: alice.id, email: 'alice@ops.example', name: 'Alice', isActive: true },
      });
    }
  });

  it('filters by status, counting only the matching tokens', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const active = await seedToken(alice.id);
    const expired = await seedToken(alice.id, { expiresAt: NOW });
    const revoked = await seedToken(alice.id, {
      revokedAt: daysFromNow(-1),
      revokeReason: 'manual',
    });
    const revokedAfterExpiry = await seedToken(alice.id, {
      expiresAt: daysFromNow(-3),
      revokedAt: daysFromNow(-1),
      revokeReason: 'manual',
    });

    const byStatus = async (status: 'active' | 'expired' | 'revoked') => {
      const result = await svc.list({ ...PAGE, status });
      return {
        total: result.total,
        ids: result.items.map((item) => item.id).sort(),
        statuses: [...new Set(result.items.map((item) => item.status))],
      };
    };

    expect(await byStatus('active')).toEqual({
      total: 1,
      ids: [active.id],
      statuses: ['active'],
    });
    expect(await byStatus('expired')).toEqual({
      total: 1,
      ids: [expired.id],
      statuses: ['expired'],
    });
    expect(await byStatus('revoked')).toEqual({
      total: 2,
      ids: [revoked.id, revokedAfterExpiry.id].sort(),
      statuses: ['revoked'],
    });
  });

  it('searches the label and the admin email, treating LIKE wildcards literally', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    const pipeline = await seedToken(alice.id, { label: 'CI pipeline' });
    const percent = await seedToken(alice.id, { label: 'Laptop 100%' });
    const underscore = await seedToken(alice.id, { label: 'desk_top' });
    const bobsToken = await seedToken(bob.id, { label: 'Workstation' });

    const idsFor = async (search: string) =>
      (await svc.list({ ...PAGE, search })).items.map((item) => item.id).sort();

    expect(await idsFor('PIPELINE')).toEqual([pipeline.id]);
    expect(await idsFor('bob@ops')).toEqual([bobsToken.id]);
    expect(await idsFor('%')).toEqual([percent.id]);
    expect(await idsFor('_')).toEqual([underscore.id]);
  });

  it('narrows the overseer list to one admin and pages with the full total', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    await seedToken(alice.id);
    await seedToken(alice.id);
    await seedToken(bob.id);

    const secondPage = await svc.list({ page: 2, limit: 1, adminUserId: alice.id });

    expect(secondPage.total).toBe(2);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]).toMatchObject({ adminUserId: alice.id });
  });

  it('sorts by the requested column in the requested direction', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    await seedToken(alice.id, { callCount: 5, createdAt: daysFromNow(-3) });
    await seedToken(alice.id, { callCount: 1, createdAt: daysFromNow(-1) });
    await seedToken(alice.id, { callCount: 3, createdAt: daysFromNow(-2) });

    const callCounts = async (query: Parameters<McpTokenService['list']>[0]) =>
      (await svc.list(query)).items.map((item) => item.callCount);

    expect(await callCounts({ ...PAGE, sortBy: 'callCount', sortOrder: 'asc' })).toEqual([1, 3, 5]);
    expect(await callCounts({ ...PAGE, sortBy: 'callCount', sortOrder: 'desc' })).toEqual([
      5, 3, 1,
    ]);
    expect(await callCounts(PAGE)).toEqual([1, 3, 5]);
  });

  it('lists never-used tokens last whichever way it sorts by last use', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    await seedToken(alice.id, { label: 'Never used' });
    await seedToken(alice.id, { label: 'Older', lastUsedAt: daysFromNow(-2), callCount: 1 });
    await seedToken(alice.id, { label: 'Newer', lastUsedAt: daysFromNow(-1), callCount: 1 });

    const labels = async (sortOrder: 'asc' | 'desc') =>
      (await svc.list({ ...PAGE, sortBy: 'lastUsedAt', sortOrder })).items.map(
        (item) => item.label,
      );

    expect(await labels('asc')).toEqual(['Older', 'Newer', 'Never used']);
    expect(await labels('desc')).toEqual(['Newer', 'Older', 'Never used']);
  });

  it('keeps a token whose admin account is gone, with the admin details empty', async () => {
    const { svc } = makeService();
    const goneAdminId = randomUUID();
    await seedToken(goneAdminId);

    const [item] = (await svc.list(PAGE)).items;

    expect(McpTokenListItemSchema.parse(item)).toEqual(item);
    expect(item?.admin).toEqual({ id: goneAdminId, email: null, name: null, isActive: null });
  });
});

describe("McpTokenService.revokeAllForUser in the caller's transaction (real PG)", () => {
  it('rolls back with the caller and audits on that transaction', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);
    let callerTx: unknown;

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        callerTx = tx;
        await svc.revokeAllForUser(
          { userId: alice.id, reason: 'admin_disabled', actorId: null },
          tx,
        );
        throw new Error('caller rolled back');
      }),
    ).rejects.toThrow('caller rolled back');

    expect(await storedToken(token.id)).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(auditEntries(audit)).toHaveLength(1);
    expect(audit.recordManyInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordManyInTransaction.mock.calls[0]?.[0]).toBe(callerTx);
  });

  it('commits with the caller', async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);

    const result = await db.drizzle.db.transaction((tx) =>
      svc.revokeAllForUser({ userId: alice.id, reason: 'admin_disabled', actorId: null }, tx),
    );

    expect(result).toEqual({ revoked: 1 });
    expect(await storedToken(token.id)).toMatchObject({ revokeReason: 'admin_disabled' });
  });
});

describe('McpTokenService.revokeAllForUsers (real PG)', () => {
  it("revokes every listed user's active tokens and nobody else's", async () => {
    const { svc } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const bob = await seedAdmin('bob@ops.example');
    const carol = await seedAdmin('carol@ops.example');
    const [alicesToken, bobsToken, carolsToken] = [
      await seedToken(alice.id),
      await seedToken(bob.id),
      await seedToken(carol.id),
    ];

    const result = await svc.revokeAllForUsers({
      userIds: [alice.id, bob.id],
      reason: 'admin_role_removed',
      actorId: null,
    });

    expect(result).toEqual({ revoked: 2 });
    expect(await storedToken(alicesToken.id)).toMatchObject({ revokeReason: 'admin_role_removed' });
    expect(await storedToken(bobsToken.id)).toMatchObject({ revokeReason: 'admin_role_removed' });
    expect(await storedToken(carolsToken.id)).toMatchObject({ revokedAt: null });
  });

  it('revokes nothing for an empty list', async () => {
    const { svc, audit } = makeService();
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);

    expect(
      await svc.revokeAllForUsers({ userIds: [], reason: 'admin_role_removed', actorId: null }),
    ).toEqual({ revoked: 0 });
    expect(await storedToken(token.id)).toMatchObject({ revokedAt: null });
    expect(auditEntries(audit)).toEqual([]);
  });
});

describe('McpTokenService bulk revocation racing an issue (real PG)', () => {
  it('revokes a token whose issue commits while a bulk revoke waits for it', async () => {
    const alice = await seedAdmin('alice@ops.example');
    const overseer = await seedAdmin('overseer@ops.example');
    const issuer = makeService();
    let markInserted = () => {};
    let releaseIssue = () => {};
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve;
    });
    const issueHeld = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    issuer.audit.recordInTransaction.mockImplementationOnce(async () => {
      markInserted();
      await issueHeld;
    });

    const issuing = issueAs(issuer.svc, alice, { label: 'In flight' });
    await inserted;
    const revoking = makeService().svc.revokeAll(overseer.id, META);
    await Promise.race([revoking, waitForTableLockWaiter(db, mcpToken)]);
    releaseIssue();
    const [issued, revoked] = await Promise.all([issuing, revoking]);

    expect(revoked).toEqual({ revoked: 1 });
    expect(await storedToken(issued.id)).toMatchObject({
      revokedBy: overseer.id,
      revokeReason: 'revoked_all',
    });
  });
});

describe('mcp_token schema (real PG)', () => {
  it('refuses a revocation time without a reason, and a reason without a time', async () => {
    const alice = await seedAdmin('alice@ops.example');
    const token = await seedToken(alice.id);
    const violation = {
      cause: expect.objectContaining({
        code: '23514',
        constraint: 'mcp_token_revocation_complete',
      }),
    };

    await expect(
      db.drizzle.db.execute(sql`UPDATE ${mcpToken} SET revoked_at = now() WHERE id = ${token.id}`),
    ).rejects.toMatchObject(violation);
    await expect(
      db.drizzle.db.execute(
        sql`UPDATE ${mcpToken} SET revoke_reason = 'manual' WHERE id = ${token.id}`,
      ),
    ).rejects.toMatchObject(violation);
    expect(await storedToken(token.id)).toMatchObject({ revokedAt: null, revokeReason: null });
  });

  it('carries the revocation check and the status-filter index from its migrations', async () => {
    const { rows: checks } = await db.drizzle.db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'mcp_token_revocation_complete'`,
    );
    const { rows: indexes } = await db.drizzle.db.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes
          where indexname = 'mcp_token_revoked_at_expires_at_idx'`,
    );

    expect(checks).toEqual([{ def: 'CHECK (((revoked_at IS NULL) = (revoke_reason IS NULL)))' }]);
    expect(indexes).toEqual([
      {
        def: 'CREATE INDEX mcp_token_revoked_at_expires_at_idx ON public.mcp_token USING btree (revoked_at, expires_at)',
      },
    ]);
  });
});
