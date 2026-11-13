import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AUDIT_READER, IDENTITY_READER } from '@openora/core/contracts';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  AUDIT_DRIZZLE,
  AUDIT_SHIPPER_DRIZZLE,
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
import { AuditReaderService } from '../service/audit-reader.service.js';
import { drainAuditOutbox } from '../service/audit-shipper.service.js';

const unique = () => randomUUID().replaceAll('-', '');
// Databases and roles made here, dropped here: a role is cluster-wide and outlives the run's sweep.
const databases: string[] = [];
const roles: string[] = [];
const newDatabase = () => {
  const name = `${testDatabasePrefix()}audit_${unique()}`;
  databases.push(name);
  return name;
};
const newRole = (kind: string) => {
  const name = `audit_${kind}_${unique().slice(0, 12)}`;
  roles.push(name);
  return { user: name, password: `pw-${randomUUID()}` };
};

const urlFor = (database: string, credentials?: { user: string; password: string }) => {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
};
const databaseOf = (url: string) => new URL(url).pathname.slice(1);

async function asAdmin(...statements: string[]) {
  const admin = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    for (const statement of statements) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }
}

const auditDatabase = newDatabase();
const writer = newRole('writer');
const shipper = newRole('shipper');
const auditUrl = urlFor(auditDatabase, writer);

let main: TestDb;
let mainDatabase: string;
let shipperUrl: string;
// The chain's database as its owner sees it and as the writer role the app runs as, and the main
// database as the shipper role.
let auditAdmin: DrizzleService;
let auditWriter: DrizzleService;
let mainShipper: DrizzleService;
let redis: TestRedis | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const savedEnv = ['REDIS_URL', 'AUDIT_DATABASE_URL', 'AUDIT_SHIPPER_DATABASE_URL'].map(
  (key) => [key, process.env[key]] as const,
);

const migrateSplit = () => migrate({ adminUrl: main.url, auditUrl, shipperUrl });

beforeAll(async () => {
  main = await createTestDb([migrateOutbox]);
  mainDatabase = databaseOf(main.url);
  databases.push(mainDatabase);
  shipperUrl = urlFor(mainDatabase, shipper);
  await migrateSplit();
  auditAdmin = new DrizzleService(urlFor(auditDatabase));
  auditWriter = new DrizzleService(auditUrl);
  mainShipper = new DrizzleService(shipperUrl);
});

afterAll(async () => {
  await app?.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all([
    auditAdmin.dispose(),
    auditWriter.dispose(),
    mainShipper.dispose(),
    main.drop(),
    redis?.quit(),
  ]);
  await asAdmin(
    ...databases.map((name) => `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    ...roles.map((name) => `DROP ROLE IF EXISTS "${name}"`),
  );
});

const ship = () => drainAuditOutbox(mainShipper.db, auditWriter.db);

const queue = (
  resourceId: string,
  action = 'test.split',
  { db = main.drizzle.db, resourceType = 'player' }: { db?: DrizzleDb; resourceType?: string } = {},
) =>
  db.transaction((tx) =>
    enqueueAuditInTransaction(tx, {
      actorType: 'system',
      action,
      resourceType,
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

async function queuedOf(resourceId: string) {
  const { rows } = await main.drizzle.db.execute<{ event_id: string; entry: unknown }>(
    sql`SELECT event_id, entry FROM audit_outbox WHERE entry->>'resourceId' = ${resourceId}
         ORDER BY id`,
  );
  return rows;
}

// What a crash between the append in the chain's database and the outbox delete in the main one
// leaves: the record in both.
async function chainWithoutShipping(resourceId: string) {
  const queued = await queuedOf(resourceId);
  await auditWriter.db.transaction((tx) =>
    appendAuditEntries(
      tx,
      queued.map(({ event_id, entry }) => ({
        eventId: event_id,
        entry: OutboxEntrySchema.parse(entry),
      })),
    ),
  );
}

const rgHistoryOf = (playerId: string, chain: DrizzleService = auditWriter) =>
  new AuditService(
    main.drizzle,
    makeEventBus(),
    mock<IdentityReader>({ getPlayerIdByUserId: vi.fn(async () => playerId) }),
    chain,
  );

async function schemaSnapshot() {
  const [chainSide, mainSide] = await Promise.all([
    auditAdmin.db.execute(sql`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations_audit) AS migrations,
             (SELECT array_agg(indexname ORDER BY indexname) FROM pg_indexes
               WHERE tablename = 'audit_log') AS indexes,
             (SELECT array_agg(tgname || ':' || tgenabled::text ORDER BY tgname) FROM pg_trigger
               WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal) AS triggers,
             (SELECT relacl::text FROM pg_class WHERE relname = 'audit_log') AS grants,
             (SELECT datacl::text FROM pg_database WHERE datname = ${auditDatabase}) AS database_acl,
             (SELECT rolconnlimit FROM pg_roles WHERE rolname = ${writer.user}) AS connection_limit,
             (SELECT rolconnlimit FROM pg_roles WHERE rolname = ${shipper.user})
               AS shipper_connection_limit`),
    main.drizzle.db.execute(sql`
      SELECT (SELECT datacl::text FROM pg_database WHERE datname = current_database())
               AS main_database_acl,
             (SELECT relacl::text FROM pg_class WHERE relname = 'audit_outbox') AS outbox_grants,
             obj_description('audit_outbox_deny_unshipped_delete()'::regprocedure, 'pg_proc')
               AS split_mark`),
  ]);
  return { ...chainSide.rows[0], ...mainSide.rows[0] };
}

describe('audit chain in a database of its own', () => {
  it('migrates a second time, and twice at once, as a no-op', async () => {
    const before = await schemaSnapshot();

    await migrateSplit();
    expect(await schemaSnapshot()).toEqual(before);
    await Promise.all([migrateSplit(), migrateSplit()]);
    expect(await schemaSnapshot()).toEqual(before);

    expect(before).toMatchObject({ connection_limit: 20, shipper_connection_limit: 20 });
    // The main database carries the outbox only.
    const { rows } = await main.drizzle.db.execute<{ chain: string | null }>(
      sql`SELECT to_regclass('audit_log')::text AS chain`,
    );
    expect(rows[0]?.chain).toBeNull();
  });

  it('lets the writer role append and read, and nothing else', async () => {
    const id = randomUUID();
    await queue(id);
    // Only the shipper role, holding its lock, may delete a queued record from the main database.
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
    const intoMain = new Pool({ connectionString: urlFor(mainDatabase, writer) });
    try {
      await expect(intoMain.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await intoMain.end();
    }
  });

  it('keeps an app role that holds the shipper lock from deleting a queued record', async () => {
    const appRole = newRole('app');
    await main.drizzle.db.execute(
      sql.raw(`CREATE ROLE "${appRole.user}" LOGIN PASSWORD '${appRole.password}'`),
    );
    await main.drizzle.db.execute(
      sql.raw(`GRANT USAGE ON SCHEMA public TO "${appRole.user}";
               GRANT SELECT, INSERT ON audit_outbox TO "${appRole.user}"`),
    );
    const connect = await main.drizzle.db.execute<{ allowed: boolean }>(
      sql`SELECT has_database_privilege(${appRole.user}, current_database(), 'CONNECT') AS allowed`,
    );
    // A role made after the first split migrate reaches the main database only once granted.
    expect(connect.rows[0]?.allowed).toBe(false);
    await main.drizzle.db.execute(
      sql.raw(`GRANT CONNECT ON DATABASE "${mainDatabase}" TO "${appRole.user}"`),
    );

    const id = randomUUID();
    await queue(id);
    const asApp = new Pool({ connectionString: urlFor(mainDatabase, appRole) });
    const deleteHoldingLock = async () => {
      const client = await asApp.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_shipper'))`);
        await client.query(`DELETE FROM audit_outbox WHERE entry->>'resourceId' = $1`, [id]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    try {
      await expect(deleteHoldingLock()).rejects.toMatchObject({ code: '42501' });
      await main.drizzle.db.execute(sql.raw(`GRANT DELETE ON audit_outbox TO "${appRole.user}"`));
      await expect(deleteHoldingLock()).rejects.toThrow(/audit shipper's to delete/);
    } finally {
      await asApp.end();
    }

    // The next migrate takes the stray grant back.
    await migrateSplit();
    const { rows } = await main.drizzle.db.execute<{ allowed: boolean }>(
      sql`SELECT has_table_privilege(${appRole.user}, 'audit_outbox', 'DELETE') AS allowed`,
    );
    expect(rows[0]?.allowed).toBe(false);
    await ship();
    expect(await queuedOf(id)).toHaveLength(0);
    expect(await chainOf(auditWriter.db, id)).toHaveLength(1);
  });

  it('refuses an audit role that is shared, privileged or a member of another role', async () => {
    const adminUser = new URL(adminDatabaseUrl()).username;
    const migrateWith = (urls: { auditUrl?: string; shipperUrl?: string }) =>
      migrate({ adminUrl: main.url, auditUrl, shipperUrl, ...urls });

    await expect(
      migrateWith({ auditUrl: urlFor(auditDatabase, { user: adminUser, password: 'any' }) }),
    ).rejects.toThrow(/role of their own/);
    await expect(migrateWith({ auditUrl: urlFor(auditDatabase, shipper) })).rejects.toThrow(
      /role of their own/,
    );

    const privileged = newRole('createdb');
    const grouped = newRole('grouped');
    await asAdmin(
      `CREATE ROLE "${privileged.user}" LOGIN CREATEDB`,
      `CREATE ROLE "${grouped.user}" LOGIN`,
      `GRANT pg_read_all_data TO "${grouped.user}"`,
    );
    await expect(migrateWith({ shipperUrl: urlFor(mainDatabase, privileged) })).rejects.toThrow(
      /CREATEDB/,
    );
    await expect(migrateWith({ shipperUrl: urlFor(mainDatabase, grouped) })).rejects.toThrow(
      /member of another role/,
    );

    const { rows } = await main.drizzle.db.execute<{ privileged: boolean; grouped: boolean }>(sql`
      SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
               AS privileged,
             EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS grouped
        FROM pg_roles r WHERE r.rolname IN (${writer.user}, ${shipper.user})`);
    expect(rows).toEqual([
      { privileged: false, grouped: false },
      { privileged: false, grouped: false },
    ]);
  });

  it('refuses a delete from a member of the shipper role, and migrate while it is one', async () => {
    const member = newRole('member');
    await asAdmin(
      `CREATE ROLE "${member.user}" LOGIN PASSWORD '${member.password}'`,
      `GRANT CONNECT ON DATABASE "${mainDatabase}" TO "${member.user}"`,
      `GRANT "${shipper.user}" TO "${member.user}"`,
    );
    const id = randomUUID();
    await queue(id);
    const asMember = new Pool({ connectionString: urlFor(mainDatabase, member) });
    try {
      const client = await asMember.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_shipper'))`);
        // The member inherits the shipper's DELETE grant; the guard takes the shipper alone.
        await expect(
          client.query(`DELETE FROM audit_outbox WHERE entry->>'resourceId' = $1`, [id]),
        ).rejects.toThrow(/audit shipper's to delete/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await asMember.end();
    }

    await expect(migrateSplit()).rejects.toThrow(/members that inherit it or may SET it/);
    await asAdmin(`REVOKE "${shipper.user}" FROM "${member.user}"`);
    await migrateSplit();
    await ship();
    expect(await chainOf(auditWriter.db, id)).toHaveLength(1);
  });

  it('takes a shipper role made by an admin that is not a superuser, its implicit membership kept', async () => {
    const creator = newRole('creator');
    const created = newRole('created');
    await asAdmin(
      `CREATE ROLE "${creator.user}" LOGIN CREATEROLE PASSWORD '${creator.password}'`,
      `GRANT CONNECT ON DATABASE "${mainDatabase}" TO "${creator.user}"`,
    );
    const asCreator = new Pool({ connectionString: urlFor(mainDatabase, creator) });
    try {
      await asCreator.query(`CREATE ROLE "${created.user}" LOGIN PASSWORD '${created.password}'`);
    } finally {
      await asCreator.end();
    }
    // PG16 grants the creator membership with ADMIN only: it neither inherits nor may SET.
    const { rows } = await main.drizzle.db.execute<{ creators: number }>(sql`
      SELECT count(*)::int AS creators FROM pg_auth_members
       WHERE roleid = ${created.user}::regrole AND member = ${creator.user}::regrole`);
    expect(rows[0]?.creators).toBe(1);

    try {
      await migrate({ adminUrl: main.url, auditUrl, shipperUrl: urlFor(mainDatabase, created) });
    } finally {
      await migrateSplit();
    }
  });

  it('resumes verification from an anchor and finds a row tampered after it', async () => {
    const id = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await queue(id);
    }
    await ship();
    const [first, second, last] = await chainOf(auditWriter.db, id);
    if (!first || !second || !last) {
      throw new Error('expected three chained rows');
    }
    const anchor = { fromSeq: first.seq, fromHash: first.hash };
    expect(await verifyAuditChain(auditWriter.db, anchor)).toEqual({ valid: true });
    expect(
      await verifyAuditChain(auditWriter.db, { fromSeq: last.seq, fromHash: last.hash }),
    ).toEqual({ valid: true });
    // An anchor past the tail names a row the chain never held: the chain was cut back.
    expect(
      await verifyAuditChain(auditWriter.db, { fromSeq: last.seq + 1000, fromHash: last.hash }),
    ).toEqual({ valid: false, firstBrokenSeq: last.seq + 1000, rowId: null });
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

    await auditAdmin.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await tx.execute(sql`DELETE FROM audit_log WHERE seq = ${second.seq}`);
      await tx.execute(sql`ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only`);
    });
    expect(
      await verifyAuditChain(auditWriter.db, { fromSeq: second.seq, fromHash: second.hash }),
    ).toEqual({ valid: false, firstBrokenSeq: second.seq, rowId: null });
  });

  it('shows a player a limit change before it ships, once, and once more after', async () => {
    const playerId = randomUUID();
    const history = () =>
      rgHistoryOf(playerId).listMyRgHistory(randomUUID(), { page: 1, limit: 10 });

    await queue(playerId, 'rg.limit.set');
    expect(await history()).toMatchObject({ total: 1, items: [{ action: 'rg.limit.set' }] });

    await chainWithoutShipping(playerId);
    expect(await history()).toMatchObject({ total: 1 });

    await ship();
    await queue(playerId, 'rg.limit.removed');
    expect(await history()).toMatchObject({
      total: 2,
      items: [{ action: 'rg.limit.removed' }, { action: 'rg.limit.set' }],
    });
  });

  it('pages a limit history across queued and chained records, each keeping its id', async () => {
    const playerId = randomUUID();
    const service = rgHistoryOf(playerId);
    const page = async (sortOrder: 'asc' | 'desc', limit: number, pageNo: number) => {
      const result = await service.listMyRgHistory(randomUUID(), {
        page: pageNo,
        limit,
        sortOrder,
      });
      expect(result.total).toBe(5);
      return result.items.map(({ id }) => id);
    };
    for (let i = 0; i < 3; i += 1) {
      await queue(playerId, 'rg.limit.set');
    }
    await ship();
    for (let i = 0; i < 2; i += 1) {
      await queue(playerId, 'rg.limit.set');
    }
    const chained = (await chainOf(auditWriter.db, playerId)).length;
    expect(chained).toBe(3);
    // Event ids, oldest first: what the chained rows were queued under, then the queued ones.
    const { rows } = await auditWriter.db.execute<{ event_id: string }>(
      sql`SELECT event_id FROM audit_log WHERE resource_id = ${playerId} ORDER BY seq`,
    );
    const oldestFirst = [
      ...rows.map(({ event_id }) => event_id),
      ...(await queuedOf(playerId)).map(({ event_id }) => event_id),
    ];
    const newestFirst = [...oldestFirst].reverse();

    for (const limit of [2, 3]) {
      for (const [sortOrder, expected] of [
        ['asc', oldestFirst],
        ['desc', newestFirst],
      ] as const) {
        for (let pageNo = 1; (pageNo - 1) * limit < expected.length; pageNo += 1) {
          expect(await page(sortOrder, limit, pageNo)).toEqual(
            expected.slice((pageNo - 1) * limit, pageNo * limit),
          );
        }
      }
    }

    // A record shipped between two page reads keeps its id and its place.
    const firstPage = await page('desc', 2, 1);
    await ship();
    expect([...firstPage, ...(await page('desc', 2, 2)), ...(await page('desc', 2, 3))]).toEqual(
      newestFirst,
    );
    expect(await page('desc', 2, 1)).toEqual(firstPage);
  });

  it('counts a limit change shipped between the queued read and the chain read once', async () => {
    const playerId = randomUUID();
    await queue(playerId, 'rg.limit.set');
    await queue(playerId, 'rg.limit.removed');
    const eventIds = (await queuedOf(playerId)).map(({ event_id }) => event_id);

    const shipsFirst = new DrizzleService(auditUrl);
    const chainDb = shipsFirst.db;
    let shipped = false;
    Object.defineProperty(shipsFirst, 'db', {
      value: new Proxy(chainDb, {
        get(target, property, receiver) {
          if (property !== 'transaction' || shipped) {
            return Reflect.get(target, property, receiver);
          }
          shipped = true;
          return async (...args: Parameters<typeof chainDb.transaction>) => {
            await ship();
            return chainDb.transaction(...args);
          };
        },
      }),
    });
    try {
      const result = await rgHistoryOf(playerId, shipsFirst).listMyRgHistory(randomUUID(), {
        page: 1,
        limit: 10,
      });
      expect(shipped).toBe(true);
      expect(await queuedOf(playerId)).toHaveLength(0);
      expect(result.total).toBe(2);
      expect(result.items.map(({ id }) => id).sort()).toEqual([...eventIds].sort());
    } finally {
      await shipsFirst.dispose();
    }
  });

  it('reads an email change once while queued, chained twice over, and shipped', async () => {
    const userId = randomUUID();
    const reader = new AuditReaderService(main.drizzle, auditWriter);
    const changes = () => reader.emailChanges({ playerId: randomUUID(), userId });

    await queue(userId, 'identity.email.changed', { resourceType: 'user' });
    expect(await changes()).toMatchObject([{ queued: true }]);
    await chainWithoutShipping(userId);
    expect(await changes()).toMatchObject([{ queued: false }]);
    await ship();
    expect(await changes()).toMatchObject([{ queued: false }]);
  });

  it('refuses the single-database paths on a split main, and shipping before the copy', async () => {
    const legacyMain = await createTestDb([migrateOutbox, migrate]);
    const legacyDatabase = databaseOf(legacyMain.url);
    databases.push(legacyDatabase);
    const legacyWriter = newRole('writer');
    const legacyShipper = newRole('shipper');
    const legacyAuditUrl = urlFor(newDatabase(), legacyWriter);
    const legacyShipperUrl = urlFor(legacyDatabase, legacyShipper);
    const db = legacyMain.drizzle.db;
    try {
      await queue(randomUUID(), 'test.legacy', { db });
      await drainAuditOutbox(db);

      await migrate({
        adminUrl: legacyMain.url,
        auditUrl: legacyAuditUrl,
        shipperUrl: legacyShipperUrl,
      });
      await queue(randomUUID(), 'test.legacy', { db });

      const asShipper = new DrizzleService(legacyShipperUrl);
      const asWriter = new DrizzleService(legacyAuditUrl);
      try {
        await expect(drainAuditOutbox(asShipper.db, asWriter.db)).rejects.toThrow(
          /copy the chain over before shipping/,
        );
      } finally {
        await Promise.all([asShipper.dispose(), asWriter.dispose()]);
      }
      await expect(migrate(legacyMain.url)).rejects.toThrow(/lives in a database of its own/);
      await expect(drainAuditOutbox(db)).rejects.toThrow(/lives in a database of its own/);
    } finally {
      await legacyMain.drop();
    }
  });

  it('ships through the app to the chain database as the writer and shipper roles', async () => {
    redis = await createTestRedis();
    process.env['REDIS_URL'] = redisUrlForWorker();
    process.env['AUDIT_DATABASE_URL'] = auditUrl;
    delete process.env['AUDIT_SHIPPER_DATABASE_URL'];
    const boot = () =>
      createApp(
        {
          plugins: [{ id: 'audit', path: fileURLToPath(new URL('../plugin.ts', import.meta.url)) }],
          databaseUrl: main.url,
        },
        (container) => {
          container.register(IDENTITY_READER, () => makeIdentityReader());
        },
      );
    await expect(boot()).rejects.toThrow(/AUDIT_SHIPPER_DATABASE_URL is required/);

    process.env['AUDIT_SHIPPER_DATABASE_URL'] = shipperUrl;
    app = await boot();
    expect(app.container.get(AUDIT_DRIZZLE)).not.toBe(app.container.get(DRIZZLE));
    expect(app.container.get(AUDIT_SHIPPER_DRIZZLE)).not.toBe(app.container.get(DRIZZLE));
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
