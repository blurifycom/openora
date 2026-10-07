import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { McpTransportConfigSchema } from '@openora/core/contracts';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { makeAuditWriter, makeEventBus, makeRateLimiter } from '../../testing/mock.js';
import { migrate as migrateIam } from '../migrate.js';
import { mcpToken } from '../schema/index.js';
import { McpTokenIssueError, McpTokenService } from '../service/mcp-token.service.js';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLogger: () => log,
}));

const META = { ip: '203.0.113.7', userAgent: 'mcp-client/1.0' };
const SHA256_HEX = /[0-9a-f]{64}/;
const TOKEN_SCHEME = 'ora_mcp_';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
  await db.drizzle.db.execute(
    sql`ALTER TABLE ${mcpToken} ADD CONSTRAINT mcp_token_test_unwritable CHECK (label <> 'unwritable')`,
  );
});

afterAll(async () => {
  await db.drop();
});

describe('McpTokenService.create when the database refuses the write (real PG)', () => {
  it('fails generically, with no cause, and logs only the error name and SQL state', async () => {
    const audit = makeAuditWriter();
    const svc = new McpTokenService({
      drizzle: db.drizzle,
      audit,
      events: makeEventBus(),
      rateLimiter: makeRateLimiter(),
      config: McpTransportConfigSchema.parse({
        enabled: true,
        allowedHosts: ['backoffice.example.com'],
      }),
    });
    const admin = await seedUser(db, { role: 'admin', isActive: true });

    const failure = await svc.create({ adminUserId: admin.id, label: 'unwritable' }, META).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(McpTokenIssueError);
    expect(failure).toMatchObject({ message: 'The MCP token could not be issued' });
    expect(failure).not.toHaveProperty('cause');
    expect(inspect(failure)).not.toMatch(SHA256_HEX);
    expect(inspect(failure)).not.toContain(TOKEN_SCHEME);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      { name: 'DrizzleQueryError', code: '23514' },
      'MCP token issuance failed',
    );
    expect(await db.drizzle.db.select().from(mcpToken)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
});
