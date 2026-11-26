import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { DrizzleService, auditOutbox, auditOutboxRejected } from '@openora/core/server';
import { migrate as migrateEngine } from '@openora/core/server/migrate';
import {
  adminDatabaseUrl,
  createTestDb,
  testDatabasePrefix,
  type TestDb,
} from '../../../testing/real-infra.js';
import { databaseOf, migrate as migrateAudit, withDatabase } from '../../migrate.js';
import { auditLog } from '../../schema/index.js';
import { main as runAuditCopy } from '../audit-copy.service.js';
import { AuditShipper, auditOutboxBacklog, drainAuditOutbox } from '../audit-shipper.service.js';
import { enqueueAuditInTransaction, verifyAuditChain, type RecordInput } from '../audit.service.js';

const opened: TestDb[] = [];
const disposables: DrizzleService[] = [];
const createdRoles: { name: string; databases: string[] }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of disposables.splice(0)) {
    await service.dispose();
  }
  const admin = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    for (const { name, databases } of createdRoles.splice(0)) {
      for (const database of databases) {
        const scoped = new Pool({ connectionString: withDatabase(adminDatabaseUrl(), database) });
        try {
          await scoped.query(`DROP OWNED BY "${name}"`);
        } finally {
          await scoped.end();
        }
      }
      await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    }
  } finally {
    await admin.end();
  }
  for (const testDb of opened.splice(0)) {
    await testDb.drop();
  }
});

async function freshChain() {
  const testDb = await createTestDb([migrateEngine, migrateAudit]);
  opened.push(testDb);
  return testDb.drizzle.db;
}

type Db = Awaited<ReturnType<typeof freshChain>>;

const entry = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  actorId: randomUUID(),
  actorType: 'admin',
  action: `test.shipper.${randomUUID()}`,
  resourceType: 'test',
  resourceId: randomUUID(),
  after: { note: randomUUID() },
  ...overrides,
});

async function enqueue(db: Db, ...entries: RecordInput[]) {
  await db.transaction(async (tx) => {
    for (const item of entries) {
      await enqueueAuditInTransaction(tx, item);
    }
  });
}

const chainRows = (db: Db) => db.select().from(auditLog).orderBy(asc(auditLog.seq));
const outboxRows = (db: Db) => db.select().from(auditOutbox).orderBy(asc(auditOutbox.id));

describe('outbox shipping', () => {
  it('enqueued entries are shipped into the chain in enqueue order', async () => {
    const db = await freshChain();
    const entries = Array.from({ length: 5 }, () => entry());
    await enqueue(db, ...entries.slice(0, 3));
    await enqueue(db, ...entries.slice(3));
    await drainAuditOutbox(db);
    const rows = await chainRows(db);
    expect(rows.map((row) => row.action)).toEqual(entries.map((item) => item.action));
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.prevHash)).toEqual([
      null,
      ...rows.slice(0, 4).map((row) => row.hash),
    ]);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
  });

  it('draining twice ships each entry once', async () => {
    const db = await freshChain();
    await enqueue(db, entry(), entry(), entry());
    await drainAuditOutbox(db);
    const afterFirst = await chainRows(db);
    await drainAuditOutbox(db);
    expect(await chainRows(db)).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(3);
    expect(await outboxRows(db)).toEqual([]);
  });

  it('an entry with an event id already shipped is skipped', async () => {
    const db = await freshChain();
    await enqueue(db, entry(), entry());
    const queued = await outboxRows(db);
    await drainAuditOutbox(db);
    const shipped = await chainRows(db);
    const [redelivered] = queued;
    if (!redelivered) {
      throw new Error('fixture');
    }
    await db.insert(auditOutbox).values({ eventId: redelivered.eventId, entry: redelivered.entry });
    expect(await auditOutboxBacklog(db)).toMatchObject({ pending: 1 });
    await drainAuditOutbox(db);
    expect(await chainRows(db)).toEqual(shipped);
    expect(await outboxRows(db)).toEqual([]);
    expect((await auditOutboxBacklog(db)).rejected).toBe(0);
  });

  it('a malformed outbox entry is rejected without blocking the rest of the batch', async () => {
    const db = await freshChain();
    const [before, after] = [entry(), entry()];
    await enqueue(db, before);
    const malformed = { eventId: randomUUID(), entry: { action: '', actorType: 'nobody' } };
    await db.insert(auditOutbox).values(malformed);
    await enqueue(db, after);
    await drainAuditOutbox(db);
    expect((await chainRows(db)).map((row) => row.action)).toEqual([before.action, after.action]);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
    const rejected = await db.select().from(auditOutboxRejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.eventId).toBe(malformed.eventId);
    expect(rejected[0]?.entry).toEqual(malformed.entry);
    expect(rejected[0]?.error.length).toBeGreaterThan(0);
    expect(await outboxRows(db)).toEqual([]);
  });

  it('the backlog count and oldest age reflect undrained rows', async () => {
    const db = await freshChain();
    expect(await auditOutboxBacklog(db)).toEqual({
      pending: 0,
      oldestPendingAgeMs: null,
      rejected: 0,
    });
    await enqueue(db, entry());
    const [queued] = await outboxRows(db);
    if (!queued) {
      throw new Error('fixture');
    }
    await db.insert(auditOutbox).values({
      eventId: randomUUID(),
      entry: queued.entry,
      createdAt: new Date(Date.now() - 300_000),
    });
    const backlog = await auditOutboxBacklog(db);
    expect(backlog.pending).toBe(2);
    expect(backlog.oldestPendingAgeMs).toBeGreaterThanOrEqual(299_000);
    expect(backlog.oldestPendingAgeMs).toBeLessThan(310_000);
    await drainAuditOutbox(db);
    expect(await auditOutboxBacklog(db)).toEqual({
      pending: 0,
      oldestPendingAgeMs: null,
      rejected: 0,
    });
  });

  it('unshipped outbox rows cannot be deleted', async () => {
    const db = await freshChain();
    await enqueue(db, entry());
    const [row] = await outboxRows(db);
    if (!row) {
      throw new Error('fixture');
    }
    await expect(db.delete(auditOutbox).where(eq(auditOutbox.id, row.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining('neither chained nor rejected') },
    });
    await expect(
      db
        .update(auditOutbox)
        .set({ entry: { tampered: true } })
        .where(eq(auditOutbox.id, row.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('append-only') } });
    await expect(db.execute(sql`TRUNCATE audit_outbox`)).rejects.toMatchObject({
      cause: { message: expect.stringContaining('append-only') },
    });
    expect(await outboxRows(db)).toEqual([row]);
  });

  it('two drainers running together never produce a duplicate or a gap', async () => {
    const db = await freshChain();
    const total = 60;
    for (let batch = 0; batch < total / 10; batch += 1) {
      await enqueue(db, ...Array.from({ length: 10 }, () => entry()));
    }
    const shippers = [
      new AuditShipper(db, { intervalMs: 5 }),
      new AuditShipper(db, { intervalMs: 5 }),
    ];
    for (const shipper of shippers) {
      shipper.start();
    }
    await Promise.all([drainAuditOutbox(db), drainAuditOutbox(db), drainAuditOutbox(db)]);
    await vi.waitFor(async () => expect((await auditOutboxBacklog(db)).pending).toBe(0));
    for (const shipper of shippers) {
      await shipper.stop();
    }
    const rows = await chainRows(db);
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(total);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
    expect(await outboxRows(db)).toEqual([]);
  });
});

type Split = {
  main: TestDb;
  mainDb: Db;
  shipperDb: Db;
  writerDb: Db;
  auditAdminDb: Db;
  writerUrl: string;
  shipperUrl: string;
};

async function splitDeployment(legacyRows = 0): Promise<Split> {
  const main = await createTestDb([migrateEngine, migrateAudit]);
  opened.push(main);
  const mainDb = main.drizzle.db;
  if (legacyRows > 0) {
    await enqueue(mainDb, ...Array.from({ length: legacyRows }, () => entry()));
    await drainAuditOutbox(mainDb);
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const auditDatabase = `${testDatabasePrefix()}audit_${suffix}`;
  const roleUrl = (role: string, database: string) => {
    const url = new URL(withDatabase(main.url, database));
    url.username = role;
    url.password = randomUUID().replaceAll('-', '');
    return url.toString();
  };
  const writerUrl = roleUrl(`audit_w_${suffix}`, auditDatabase);
  const shipperUrl = roleUrl(`audit_s_${suffix}`, databaseOf(main.url));
  createdRoles.push(
    { name: `audit_w_${suffix}`, databases: [databaseOf(main.url), auditDatabase] },
    { name: `audit_s_${suffix}`, databases: [databaseOf(main.url), auditDatabase] },
  );
  await migrateAudit({ adminUrl: main.url, auditUrl: writerUrl, shipperUrl });
  const open = (url: string) => {
    const service = new DrizzleService(url);
    disposables.push(service);
    return service.db;
  };
  return {
    main,
    mainDb,
    shipperDb: open(shipperUrl),
    writerDb: open(writerUrl),
    auditAdminDb: open(withDatabase(main.url, auditDatabase)),
    writerUrl,
    shipperUrl,
  };
}

const copyEnv = (split: Split) => ({
  DATABASE_ADMIN_URL: split.main.url,
  AUDIT_DATABASE_URL: split.writerUrl,
  AUDIT_SHIPPER_DATABASE_URL: split.shipperUrl,
});

const silenceStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('separate audit store', () => {
  it('with the chain on a separate database, shipping writes the chain there and marks the outbox shipped on the main database', async () => {
    const split = await splitDeployment();
    const entries = [entry(), entry(), entry()];
    await enqueue(split.mainDb, ...entries);
    await drainAuditOutbox(split.shipperDb, split.writerDb);
    const chained = await chainRows(split.auditAdminDb);
    expect(chained.map((row) => row.action)).toEqual(entries.map((item) => item.action));
    expect(await verifyAuditChain(split.auditAdminDb)).toEqual({ valid: true });
    expect(await outboxRows(split.mainDb)).toEqual([]);
    expect(await chainRows(split.mainDb)).toEqual([]);
  });

  it('shipping refuses when the chain store lacks rows the main database chain already holds', async () => {
    const split = await splitDeployment(2);
    await enqueue(split.mainDb, entry());
    await expect(drainAuditOutbox(split.shipperDb, split.writerDb)).rejects.toThrow(
      /lacks the main database's audit_log up to seq 2: copy the chain over before shipping/,
    );
    expect(await outboxRows(split.mainDb)).toHaveLength(1);
    expect(await chainRows(split.auditAdminDb)).toEqual([]);
  });

  it('copy to a separate audit store copies every row and the copied chain verifies', async () => {
    const split = await splitDeployment(5);
    silenceStdout();
    expect(await runAuditCopy(['--apply'], copyEnv(split))).toBe(0);
    const source = await chainRows(split.mainDb);
    const copied = await chainRows(split.auditAdminDb);
    expect(source).toHaveLength(5);
    expect(copied).toEqual(source);
    expect(await verifyAuditChain(split.auditAdminDb)).toEqual({ valid: true });
  });

  it('copy run twice does not duplicate rows', async () => {
    const split = await splitDeployment(4);
    silenceStdout();
    expect(await runAuditCopy(['--apply'], copyEnv(split))).toBe(0);
    const afterFirst = await chainRows(split.auditAdminDb);
    expect(await runAuditCopy(['--apply'], copyEnv(split))).toBe(0);
    expect(await chainRows(split.auditAdminDb)).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(4);
  });

  it('copy refuses a target that is the same database as the source', async () => {
    const main = await createTestDb([migrateEngine, migrateAudit]);
    opened.push(main);
    await enqueue(main.drizzle.db, entry());
    await drainAuditOutbox(main.drizzle.db);
    const before = await chainRows(main.drizzle.db);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAuditCopy(['--apply'], {
      DATABASE_ADMIN_URL: main.url,
      AUDIT_DATABASE_URL: main.url,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('AUDIT_DATABASE_URL must name a database other than the main one'),
    );
    expect(await chainRows(main.drizzle.db)).toEqual(before);
  });

  it('after the split the main database stops accepting chain rows', async () => {
    const split = await splitDeployment(2);
    silenceStdout();
    expect(await runAuditCopy(['--apply', '--fence'], copyEnv(split))).toBe(0);
    await expect(
      split.mainDb.execute(sql`INSERT INTO audit_log DEFAULT VALUES`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('audit_log moved to its own database') },
    });
    await enqueue(split.mainDb, entry());
    await expect(drainAuditOutbox(split.mainDb)).rejects.toThrow(/lives in a database of its own/);
    expect(await chainRows(split.mainDb)).toHaveLength(2);
    expect(await outboxRows(split.mainDb)).toHaveLength(1);
  });
});
