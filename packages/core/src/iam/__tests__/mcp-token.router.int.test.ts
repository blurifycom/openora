import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  McpTransportConfigSchema,
  type MailDispatchPort,
  type McpTransportConfig,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { user } from '@openora/core/pam/schema/identity';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeRateLimiter,
  mock,
  testContext,
} from '../../testing/mock.js';
import { migrate as migrateIam } from '../migrate.js';
import { mcpToken } from '../schema/index.js';
import { createIamRouter } from '../router/index.js';
import { IamService } from '../service/iam.service.js';
import { McpTokenService } from '../service/mcp-token.service.js';

const HOUR_MS = 60 * 60 * 1000;
const BACKOFFICE_HOSTS = ['backoffice.example.com'];
const ENABLED = McpTransportConfigSchema.parse({ enabled: true, allowedHosts: BACKOFFICE_HOSTS });
const CTX = testContext();

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${mcpToken}, ${user} RESTART IDENTITY CASCADE`);
});

function buildRouter({
  guard,
  config = ENABLED,
  rateLimiter = makeRateLimiter(),
}: {
  guard: AdminGuard;
  config?: McpTransportConfig;
  rateLimiter?: RateLimiterAdapter<RateLimitKey>;
}) {
  const mcpTokens = new McpTokenService({
    drizzle: db.drizzle,
    audit: makeAuditWriter(),
    events: makeEventBus(),
    rateLimiter,
    config,
  });
  const iam = new IamService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    mailDispatch: mock<MailDispatchPort>({}),
    identityReader: makeIdentityReader(),
    mcpTokens,
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

const issue = (
  router: ReturnType<typeof buildRouter>,
  input: { label: string; ttlDays?: number },
) => call(router.mcpTokens.create, input, { context: CTX });

describe('iam router mcpTokens.create errors (real PG)', () => {
  it('refuses a caller without mcp-access before anything is issued', async () => {
    const owner = await seedUser(db, { role: 'admin' });
    const router = buildRouter({
      guard: makeAdminGuard({ allow: [], caller: { userId: owner.id } }),
    });

    expect(await transportError(issue(router, { label: 'Denied' }))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });

  it('answers an inactive owner FORBIDDEN owner_ineligible', async () => {
    const owner = await seedUser(db, { role: 'admin', isActive: false });
    const router = buildRouter({ guard: makeAdminGuard({ caller: { userId: owner.id } }) });

    expect(await transportError(issue(router, { label: 'Stale session' }))).toEqual({
      code: 'FORBIDDEN',
      data: { reason: 'owner_ineligible' },
    });
  });

  it('answers an owner at the active-token cap CONFLICT token_limit', async () => {
    const owner = await seedUser(db, { role: 'admin' });
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      config: McpTransportConfigSchema.parse({
        enabled: true,
        allowedHosts: BACKOFFICE_HOSTS,
        tokenIssuance: { maxActivePerAdmin: 1 },
      }),
    });
    await issue(router, { label: 'First' });

    expect(await transportError(issue(router, { label: 'Second' }))).toEqual({
      code: 'CONFLICT',
      data: { reason: 'token_limit' },
    });
  });

  it('answers a disabled transport CONFLICT mcp_disabled', async () => {
    const owner = await seedUser(db, { role: 'admin' });
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      config: McpTransportConfigSchema.parse({}),
    });

    expect(await transportError(issue(router, { label: 'Off' }))).toEqual({
      code: 'CONFLICT',
      data: { reason: 'mcp_disabled' },
    });
  });

  it('answers a lifetime over the cap BAD_REQUEST ttl_exceeds_max', async () => {
    const owner = await seedUser(db, { role: 'admin' });
    const router = buildRouter({ guard: makeAdminGuard({ caller: { userId: owner.id } }) });

    expect(await transportError(issue(router, { label: 'Long', ttlDays: 91 }))).toEqual({
      code: 'BAD_REQUEST',
      data: { reason: 'ttl_exceeds_max' },
    });
  });

  it('answers an owner over the hourly limit TOO_MANY_REQUESTS with the retry delay', async () => {
    const owner = await seedUser(db, { role: 'admin' });
    const router = buildRouter({
      guard: makeAdminGuard({ caller: { userId: owner.id } }),
      rateLimiter: mock<RateLimiterAdapter<RateLimitKey>>({
        consume: vi.fn(async () => ({ allowed: false, retryAfterMs: HOUR_MS })),
        reset: vi.fn(),
      }),
    });

    expect(await transportError(issue(router, { label: 'Throttled' }))).toEqual({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: HOUR_MS },
    });
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
  });
});
