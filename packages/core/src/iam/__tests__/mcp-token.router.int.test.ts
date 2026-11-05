import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  McpTransportConfigSchema,
  type FreshReauthentication,
  type MailDispatchPort,
  type McpTransportConfig,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { session, user, type Session, type User } from '@openora/core/pam/schema/identity';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeFreshReauthentication,
  makeIdentityReader,
  makeUserCommands,
  makeRateLimiter,
  mock,
  testContext,
} from '../../testing/mock.js';
import { migrate as migrateIam } from '../migrate.js';
import { adminRole, adminRolePermission, adminRoleAssignment, mcpToken } from '../schema/index.js';
import { createIamRouter } from '../router/index.js';
import { IamService } from '../service/iam.service.js';
import { McpTokenService } from '../service/mcp-token.service.js';

const HOUR_MS = 60 * 60 * 1000;
const BACKOFFICE_HOSTS = ['backoffice.example.com'];
const ENABLED = McpTransportConfigSchema.parse({ enabled: true, allowedHosts: BACKOFFICE_HOSTS });

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${mcpToken}, ${adminRole}, ${adminRolePermission}, ${adminRoleAssignment}, ${user} RESTART IDENTITY CASCADE`,
  );
});

function buildRouter({
  guard,
  config = ENABLED,
  rateLimiter = makeRateLimiter(),
  reauthentication = makeFreshReauthentication(),
}: {
  guard: AdminGuard;
  config?: McpTransportConfig;
  rateLimiter?: RateLimiterAdapter<RateLimitKey>;
  reauthentication?: FreshReauthentication;
}) {
  const mcpTokens = new McpTokenService({
    drizzle: db.drizzle,
    audit: makeAuditWriter(),
    events: makeEventBus(),
    rateLimiter,
    reauthentication,
    config,
  });
  const iam = new IamService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    mailDispatch: mock<MailDispatchPort>({}),
    identityReader: makeIdentityReader(),
    mcpTokens,
    userCommands: makeUserCommands(),
  });
  return createIamRouter(iam, guard, mcpTokens);
}

async function transportError(promise: Promise<unknown>) {
  const err = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(ORPCError);
  return err instanceof ORPCError ? { code: err.code, data: err.data } : undefined;
}

/**
 * With the permission resolver bound, an admin holds nothing without a role
 * assignment, so an MCP token owner needs a real role granting `mcp-access`.
 */
async function grantMcpAccess(userId: string) {
  const [role] = await db.drizzle.db
    .insert(adminRole)
    .values({ name: `MCP ${crypto.randomUUID()}` })
    .returning({ id: adminRole.id });
  if (!role) {
    throw new Error('grantMcpAccess: role insert returned no row');
  }
  await db.drizzle.db
    .insert(adminRolePermission)
    .values({ roleId: role.id, resource: 'mcp-access', level: 'read_write' });
  await db.drizzle.db.insert(adminRoleAssignment).values({ userId, roleId: role.id });
}

async function seedOwner(over: Partial<typeof user.$inferInsert> = {}) {
  const owner = await seedUser(db, { role: 'admin', ...over });
  await grantMcpAccess(owner.id);
  const [live] = await db.drizzle.db
    .insert(session)
    .values({
      userId: owner.id,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + HOUR_MS),
      updatedAt: new Date(),
    })
    .returning({ id: session.id });
  return { id: owner.id, sessionId: live?.id };
}

const issue = (
  router: ReturnType<typeof buildRouter>,
  owner: { id: User['id']; sessionId: Session['id'] | undefined },
  input: { label: string; ttlDays?: number; totpCode?: string },
) =>
  call(
    router.mcpTokens.create,
    { currentPassword: 'password1234', ...input },
    {
      context: testContext({ auth: { userId: owner.id, sessionId: owner.sessionId } }),
    },
  );

describe('iam router mcpTokens.create errors (real PG)', () => {
  it('refuses a caller without mcp-access before anything is issued', async () => {
    const owner = await seedOwner();
    const router = buildRouter({
      guard: makeAdminGuard({ allow: [], caller: { userId: owner.id } }),
    });

    expect(await transportError(issue(router, owner, { label: 'Denied' }))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  it('answers an inactive owner FORBIDDEN owner_ineligible', async () => {
    const owner = await seedOwner({ isActive: false });
    const router = buildRouter({ guard: makeAdminGuard({ caller: { userId: owner.id } }) });

    expect(await transportError(issue(router, owner, { label: 'Stale session' }))).toEqual({
      code: 'FORBIDDEN',
      data: { reason: 'owner_ineligible' },
    });
  });

  it('answers an owner at the active-token cap CONFLICT token_limit', async () => {
    const owner = await seedOwner();
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      config: McpTransportConfigSchema.parse({
        enabled: true,
        allowedHosts: BACKOFFICE_HOSTS,
        tokenIssuance: { maxActivePerAdmin: 1 },
      }),
    });
    await issue(router, owner, { label: 'First' });

    expect(await transportError(issue(router, owner, { label: 'Second' }))).toEqual({
      code: 'CONFLICT',
      data: { reason: 'token_limit' },
    });
  });

  it('answers a request that carries no session FORBIDDEN owner_ineligible, issuing nothing', async () => {
    const owner = await seedOwner();
    const router = buildRouter({ guard: makeAdminGuard({ caller: { userId: owner.id } }) });

    expect(
      await transportError(issue(router, { ...owner, sessionId: undefined }, { label: 'Bare' })),
    ).toEqual({ code: 'FORBIDDEN', data: { reason: 'owner_ineligible' } });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  it('answers a disabled transport CONFLICT mcp_disabled', async () => {
    const owner = await seedOwner();
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      config: McpTransportConfigSchema.parse({}),
    });

    expect(await transportError(issue(router, owner, { label: 'Off' }))).toEqual({
      code: 'CONFLICT',
      data: { reason: 'mcp_disabled' },
    });
  });

  it('answers a lifetime over the cap BAD_REQUEST ttl_exceeds_max', async () => {
    const owner = await seedOwner();
    const router = buildRouter({ guard: makeAdminGuard({ caller: { userId: owner.id } }) });

    expect(await transportError(issue(router, owner, { label: 'Long', ttlDays: 91 }))).toEqual({
      code: 'BAD_REQUEST',
      data: { reason: 'ttl_exceeds_max' },
    });
  });

  it('answers an owner over the hourly limit TOO_MANY_REQUESTS with the retry delay', async () => {
    const owner = await seedOwner();
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      rateLimiter: mock<RateLimiterAdapter<RateLimitKey>>({
        consume: vi.fn(async () => ({ allowed: false, retryAfterMs: HOUR_MS })),
        reset: vi.fn(),
      }),
    });

    expect(await transportError(issue(router, owner, { label: 'Throttled' }))).toEqual({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: HOUR_MS },
    });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  it('refuses a request without the current password before the service runs', async () => {
    const owner = await seedOwner();
    const reauthentication = makeFreshReauthentication();
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      reauthentication,
    });

    const refusal = call(
      router.mcpTokens.create,
      mock<{ label: string; currentPassword: string }>({ label: 'No password' }),
      { context: testContext({ auth: { userId: owner.id, sessionId: owner.sessionId } }) },
    );

    expect(await transportError(refusal)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(reauthentication.assert).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  const LOCKED_UNTIL = new Date('2026-11-02T13:00:00.000Z');
  it.each([
    [
      'a wrong password',
      { status: 'password_invalid' },
      { code: 'FORBIDDEN', data: { reason: 'reauthentication_failed' } },
    ],
    [
      'a missing second-factor code',
      { status: 'second_factor_required' },
      { code: 'UNPROCESSABLE_CONTENT', data: { reason: 'reauthentication_required' } },
    ],
    [
      'a wrong second-factor code',
      { status: 'second_factor_invalid', attemptsLeft: 3 },
      { code: 'FORBIDDEN', data: { reason: 'reauthentication_failed', attemptsLeft: 3 } },
    ],
    [
      'a second factor under lockout',
      { status: 'locked', lockedUntil: LOCKED_UNTIL },
      {
        code: 'FORBIDDEN',
        data: { reason: 'reauthentication_locked', lockedUntil: LOCKED_UNTIL.toISOString() },
      },
    ],
  ] as const)(
    'answers %s with its typed reason, issuing nothing',
    async (_case, verdict, answer) => {
      const owner = await seedOwner();
      const router = buildRouter({
        guard: makeAdminGuard({ caller: { userId: owner.id } }),
        reauthentication: makeFreshReauthentication(verdict),
      });

      expect(await transportError(issue(router, owner, { label: 'Refused' }))).toEqual(answer);
      expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    },
  );

  it('hands the request headers and the proof to the re-authentication', async () => {
    const owner = await seedOwner();
    const reauthentication = makeFreshReauthentication();
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      reauthentication,
    });
    const headers = { cookie: 'session=abc', 'user-agent': 'backoffice/1.0' };

    await call(
      router.mcpTokens.create,
      { label: 'Proved', currentPassword: 'password1234', totpCode: '123456' },
      {
        context: testContext({
          request: { headers },
          auth: { userId: owner.id, sessionId: owner.sessionId },
        }),
      },
    );

    expect(reauthentication.assert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: owner.id,
        headers,
        currentPassword: 'password1234',
        totpCode: '123456',
      }),
    );
  });
});
