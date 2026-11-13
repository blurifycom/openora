import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AUDIT_READER, IDENTITY_READER } from '@openora/core/contracts';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  AUDIT_DRIZZLE,
  DRIZZLE,
  DrizzleService,
  EVENT_BUS,
  createApp,
  type DrizzleDb,
} from '@openora/core/server';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { adminDatabaseUrl, testDatabasePrefix } from '../../testing/real-infra.js';
import { makeEventBus, makeIdentityReader, mock } from '../../testing/mock.js';
import type { IdentityReader } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { auditLog } from '../schema/index.js';
import {
  AuditService,
  appendAuditEntries,
  enqueueAuditInTransaction,
  OutboxEntrySchema,
  verifyAuditChain,
} from '../service/audit.service.js';
import { drainAuditOutbox } from '../service/audit-shipper.service.js';

const auditDatabase = `${testDatabasePrefix()}audit_${randomUUID().replaceAll('-', '')}`;
const writerRole = `audit_writer_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const writerPassword = `pw-${randomUUID()}`;

const urlFor = (database: string, credentials?: { user: string; password: string }) => {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
};
const auditUrl = urlFor(auditDatabase, { user: writerRole, password: writerPassword });

let main: TestDb;
let mainDatabase: string;
// The chain's database as its owner sees it, and as the writer role the app runs as.
let auditAdmin: DrizzleService;
let auditWriter: DrizzleService;
let redis: TestRedis | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const savedEnv = {
  redis: process.env['REDIS_URL'],
  auditUrl: process.env['AUDIT_DATABASE_URL'],
};

const migrateSplit = () => migrate({ adminUrl: main.url, auditUrl });

beforeAll(async () => {
  main = await createTestDb([migrateOutbox]);
  mainDatabase = new URL(main.url).pathname.slice(1);
  await migrateSplit();
  auditAdmin = new DrizzleService(urlFor(auditDatabase));
  auditWriter = new DrizzleService(auditUrl);
});

afterAll(async () => {
  await app?.close();
  for (const [key, value] of [
    ['REDIS_URL', savedEnv.redis],
    ['AUDIT_DATABASE_URL', savedEnv.auditUrl],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all([auditAdmin.dispose(), auditWriter.dispose(), main.drop(), redis?.quit()]);
  // Created here, so dropped here: the role is cluster-wide, and outlives the run's sweep.
  const admin = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${auditDatabase}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${writerRole}"`);
  } finally {
    await admin.end();
  }
});

const ship = () => drainAuditOutbox(main.drizzle.db, auditWriter.db);

const queue = (resourceId: string, action = 'test.split') =>
  main.drizzle.db.transaction((tx) =>
    enqueueAuditInTransaction(tx, {
      actorType: 'system',
      action,
      resourceType: 'player',
      resourceId,
      after: { marker: resourceId },
    }),
  );

const chainOf = (db: DrizzleDb, resourceId: string) =>
  db
    .select({ seq: auditLog.seq, hash: auditLog.hash, action: auditLog.action })
    .from(auditLog)
    .where(sql`${auditLog.resourceId} = ${resourceId}`)
    .orderBy(auditLog.seq);

async function schemaSnapshot() {
  const { rows } = await auditAdmin.db.execute(sql`
    SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations_audit) AS migrations,
           (SELECT array_agg(indexname ORDER BY indexname) FROM pg_indexes
             WHERE tablename = 'audit_log') AS indexes,
           (SELECT array_agg(tgname || ':' || tgenabled::text ORDER BY tgname) FROM pg_trigger
             WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal) AS triggers,
           (SELECT relacl::text FROM pg_class WHERE relname = 'audit_log') AS grants,
           (SELECT datacl::text FROM pg_database WHERE datname = ${auditDatabase}) AS database_acl,
           (SELECT rolconnlimit FROM pg_roles WHERE rolname = ${writerRole}) AS connection_limit`);
  return rows[0];
}

describe('audit chain in a database of its own', () => {
  it('migrates a second time as a no-op', async () => {
    const before = await schemaSnapshot();

    await migrateSplit();

    expect(await schemaSnapshot()).toEqual(before);
    expect(before).toMatchObject({ connection_limit: 20 });
    // The main database carries the outbox only.
    const { rows } = await main.drizzle.db.execute<{ chain: string | null }>(
      sql`SELECT to_regclass('audit_log')::text AS chain`,
    );
    expect(rows[0]?.chain).toBeNull();
  });

  it('lets the writer role append and read, and nothing else', async () => {
    const id = randomUUID();
    await queue(id);
    // Only the shipper, holding its lock, may delete a queued record from the main database.
    await expect(
      main.drizzle.db.execute(sql`DELETE FROM audit_outbox WHERE entry->>'resourceId' = ${id}`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/DELETE is not permitted/) },
    });
    await ship();
    expect(await chainOf(auditWriter.db, id)).toHaveLength(1);

    for (const statement of [
      `UPDATE audit_log SET action = 'forged'`,
      `DELETE FROM audit_log`,
      `TRUNCATE audit_log`,
      `CREATE TABLE planted (id int)`,
    ]) {
      await expect(auditWriter.db.execute(sql.raw(statement))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    }
    const intoMain = new Pool({
      connectionString: urlFor(mainDatabase, { user: writerRole, password: writerPassword }),
    });
    try {
      await expect(intoMain.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await intoMain.end();
    }
  });

  it('resumes verification from an anchor and finds a row tampered after it', async () => {
    const id = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await queue(id);
    }
    await ship();
    const [first, second] = await chainOf(auditWriter.db, id);
    if (!first || !second) {
      throw new Error('expected three chained rows');
    }
    const anchor = { fromSeq: first.seq, fromHash: first.hash };
    expect(await verifyAuditChain(auditWriter.db, anchor)).toEqual({ valid: true });
    expect(
      await verifyAuditChain(auditWriter.db, { ...anchor, fromHash: second.hash }),
    ).toMatchObject({ valid: false, firstBrokenSeq: first.seq });

    await auditAdmin.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await tx.execute(sql`UPDATE audit_log SET action = 'forged' WHERE seq = ${second.seq}`);
      await tx.execute(sql`ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only`);
    });

    expect(await verifyAuditChain(auditWriter.db, anchor)).toMatchObject({
      valid: false,
      firstBrokenSeq: second.seq,
    });
  });

  it('shows a player a limit change before it ships, once, and once more after', async () => {
    const playerId = randomUUID();
    const userId = randomUUID();
    const service = new AuditService(
      main.drizzle,
      makeEventBus(),
      mock<IdentityReader>({ getPlayerIdByUserId: vi.fn(async () => playerId) }),
      auditWriter,
    );
    const history = () => service.listMyRgHistory(userId, { page: 1, limit: 10 });

    await queue(playerId, 'rg.limit.set');
    expect(await history()).toMatchObject({ total: 1, items: [{ action: 'rg.limit.set' }] });

    // A crash between the append in the chain's database and the outbox delete in the main one
    // leaves the record in both; it still shows once.
    const { rows } = await main.drizzle.db.execute<{ event_id: string; entry: unknown }>(
      sql`SELECT event_id, entry FROM audit_outbox WHERE entry->>'resourceId' = ${playerId}`,
    );
    const [queued] = rows;
    if (!queued) {
      throw new Error('expected the limit change queued');
    }
    await auditWriter.db.transaction((tx) =>
      appendAuditEntries(tx, [
        { eventId: queued.event_id, entry: OutboxEntrySchema.parse(queued.entry) },
      ]),
    );
    expect(await history()).toMatchObject({ total: 1 });

    await ship();
    await queue(playerId, 'rg.limit.removed');
    expect(await history()).toMatchObject({
      total: 2,
      items: [{ action: 'rg.limit.removed' }, { action: 'rg.limit.set' }],
    });
  });

  it('ships through the app to the chain database as the writer role', async () => {
    redis = await createTestRedis();
    process.env['REDIS_URL'] = redisUrlForWorker();
    process.env['AUDIT_DATABASE_URL'] = auditUrl;
    app = await createApp(
      {
        plugins: [{ id: 'audit', path: fileURLToPath(new URL('../plugin.ts', import.meta.url)) }],
        databaseUrl: main.url,
      },
      (container) => {
        container.register(IDENTITY_READER, () => makeIdentityReader());
      },
    );
    expect(app.container.get(AUDIT_DRIZZLE)).not.toBe(app.container.get(DRIZZLE));
    expect(app.container.has(AUDIT_READER)).toBe(true);

    const marker = randomUUID();
    const bus = app.container.get(EVENT_BUS);
    await main.drizzle.db.transaction((tx) =>
      bus.emitInTransaction(tx, 'tag.created', { key: 'vip', isSticky: false, actorId: marker }),
    );

    // The outbox row goes once the append has committed in the chain's database.
    await vi.waitFor(
      async () => {
        const [chained, queued] = await Promise.all([
          auditAdmin.db.execute<{ rows: number }>(
            sql`SELECT count(*)::int AS rows FROM audit_log WHERE after->>'actorId' = ${marker}`,
          ),
          main.drizzle.db.execute<{ rows: number }>(
            sql`SELECT count(*)::int AS rows FROM audit_outbox
                 WHERE entry->'after'->>'actorId' = ${marker}`,
          ),
        ]);
        expect([chained.rows[0]?.rows, queued.rows[0]?.rows]).toEqual([1, 0]);
      },
      { timeout: 10_000 },
    );
  });
});
