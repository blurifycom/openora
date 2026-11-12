import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { auditOutbox, type DrizzleDb } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { makeEventBus, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { auditLog } from '../schema/index.js';
import {
  AuditService,
  appendAuditEntries,
  enqueueAuditInTransaction,
  type RecordInput,
} from '../service/audit.service.js';
import {
  AuditShipper,
  drainAuditOutbox,
  shipAuditBatch,
} from '../service/audit-shipper.service.js';

let db: TestDb;
let main: DrizzleDb;
// A second pool on the same database, so the shipper takes its separate-target path: the append
// commits on its own and the outbox delete commits after it, as with a dedicated audit database.
let target: DrizzleDb;
let targetPool: Pool;

const entry = (resourceId: string, over: Partial<RecordInput> = {}): RecordInput => ({
  actorId: 'admin-1',
  actorType: 'admin',
  action: 'test.changed',
  resourceType: 'test',
  resourceId,
  after: { resourceId },
  ...over,
});

const service = () => new AuditService(db.drizzle, makeEventBus(), makeIdentityReader());

async function count(table: 'audit_log' | 'audit_outbox') {
  const { rows } = await main.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return rows[0]?.n;
}

// The chain as one line: one head, each row after the one before, nothing branching off it.
async function expectLinearChain(length: number) {
  expect(await service().verifyChain()).toEqual({ valid: true });
  const { rows } = await main.execute<{ rows: number; seqs: number; links: number }>(
    sql`select count(*)::int as rows, count(distinct seq)::int as seqs,
               count(distinct coalesce(prev_hash, ''))::int as links from audit_log`,
  );
  expect(rows[0]).toEqual({ rows: length, seqs: length, links: length });
}

// Holds `key`'s transaction-scoped advisory lock on its own connection until `release` runs.
async function holdLock(key: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const held = new Promise<void>((resolve) => (locked = resolve));
  const done = main.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    locked();
    await released;
  });
  await held;
  return async () => {
    release();
    await done;
  };
}

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
  main = db.drizzle.db;
  targetPool = new Pool({ connectionString: db.url });
  target = drizzle(targetPool, { casing: 'snake_case' });
});

afterAll(async () => {
  await targetPool.end();
  await db.drop();
});

beforeEach(async () => {
  await main.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate`);
    await tx.execute(sql`TRUNCATE audit_log, audit_outbox RESTART IDENTITY`);
    await tx.execute(sql`ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate`);
  });
});

describe('audit outbox capture (real PG)', () => {
  it('leaves no outbox row and no audit row when the business transaction rolls back', async () => {
    await expect(
      main.transaction(async (tx) => {
        await service().recordInTransaction(tx, entry('single'));
        await service().recordManyInTransaction(tx, [entry('bulk-1'), entry('bulk-2')]);
        throw new Error('business rolled back');
      }),
    ).rejects.toThrow('business rolled back');
    await drainAuditOutbox(main);

    expect(await count('audit_outbox')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });

  it('fails the business transaction on a malformed entry, before anything is queued', async () => {
    const bad = { ...entry('bad'), actorType: 'robot' } as unknown as RecordInput;

    await expect(
      main.transaction(async (tx) => {
        await service().recordInTransaction(tx, entry('good'));
        await service().recordInTransaction(tx, bad);
      }),
    ).rejects.toThrow();
    await expect(
      main.transaction((tx) => service().recordInTransaction(tx, entry('', { action: '' }))),
    ).rejects.toThrow();

    expect(await count('audit_outbox')).toBe(0);
  });

  it('writes one row for an event queued twice, before and after it ships', async () => {
    const eventId = randomUUID();
    const queue = () =>
      main.transaction((tx) => enqueueAuditInTransaction(tx, entry('once'), eventId));

    await queue();
    await queue();
    expect(await count('audit_outbox')).toBe(1);
    await drainAuditOutbox(main);
    await queue();
    await drainAuditOutbox(main);

    expect(await count('audit_log')).toBe(1);
    expect(await count('audit_outbox')).toBe(0);
    const [row] = await main.select().from(auditLog);
    expect(row?.eventId).toBe(eventId);
  });

  it('does not wait on the chain lock: 50 business transactions commit while it is held', async () => {
    const release = await holdLock('audit_log');
    try {
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          main.transaction((tx) => service().recordInTransaction(tx, entry(`w-${index}`))),
        ),
      );
      expect(await count('audit_outbox')).toBe(50);
    } finally {
      await release();
    }
    await drainAuditOutbox(main);

    await expectLinearChain(50);
  });
});

describe('audit shipper (real PG)', () => {
  it('re-ships a batch whose delete never ran without writing it twice', async () => {
    await main.transaction((tx) =>
      service().recordManyInTransaction(tx, [entry('a'), entry('b'), entry('c')]),
    );
    // The shipper crashed after the chain commit and before deleting the outbox rows.
    const queued = await main.select().from(auditOutbox).orderBy(auditOutbox.id);
    await target.transaction((tx) => appendAuditEntries(tx, queued));
    expect(await count('audit_outbox')).toBe(3);

    expect(await shipAuditBatch(main, target)).toBe(3);

    expect(await count('audit_outbox')).toBe(0);
    await expectLinearChain(3);
  });

  it('refuses a second row for an event even past the shipper, via the unique event_id', async () => {
    const eventId = randomUUID();
    await main.transaction((tx) => enqueueAuditInTransaction(tx, entry('x'), eventId));
    await drainAuditOutbox(main);
    const [row] = await main.select().from(auditLog);

    await expect(
      main.insert(auditLog).values({
        ...row!,
        id: randomUUID(),
        seq: row!.seq + 1,
        prevHash: row!.hash,
        hash: randomUUID(),
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('refuses a fork and a reused seq even past the chain lock', async () => {
    await main.transaction((tx) => service().recordInTransaction(tx, entry('head')));
    await drainAuditOutbox(main);
    const [head] = await main.select().from(auditLog);
    const forged = { ...head!, eventId: null, hash: randomUUID() };

    await expect(
      main.insert(auditLog).values({ ...forged, id: randomUUID(), seq: head!.seq + 1 }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      main.insert(auditLog).values({ ...forged, id: randomUUID(), prevHash: head!.hash }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('skips a tick while another shipper holds the lock, and ships after it lets go', async () => {
    await main.transaction((tx) => service().recordInTransaction(tx, entry('waiting')));
    const release = await holdLock('audit_shipper');
    try {
      expect(await shipAuditBatch(main, main)).toBeNull();
      expect(await count('audit_log')).toBe(0);
    } finally {
      await release();
    }

    expect(await shipAuditBatch(main, main)).toBe(1);
    await expectLinearChain(1);
  });

  it('keeps one linear chain with 2k entries from concurrent writers and two shippers', async () => {
    const shippers = [
      new AuditShipper(main, main, { intervalMs: 5 }),
      new AuditShipper(main, target, { intervalMs: 5 }),
    ];
    const errors: unknown[] = [];
    for (const shipper of shippers) {
      shipper.start();
    }
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, writer) =>
          (async () => {
            for (let txn = 0; txn < 10; txn++) {
              await main.transaction(async (tx) => {
                const svc = service();
                await svc.recordInTransaction(tx, entry(`${writer}-${txn}-single`));
                await svc.recordManyInTransaction(
                  tx,
                  Array.from({ length: 9 }, (_, n) => entry(`${writer}-${txn}-bulk-${n}`)),
                );
              });
            }
          })().catch((err: unknown) => errors.push(err)),
        ),
      );
    } finally {
      await Promise.all(shippers.map((shipper) => shipper.stop()));
    }
    await drainAuditOutbox(main);

    expect(errors).toEqual([]);
    expect(await count('audit_outbox')).toBe(0);
    await expectLinearChain(2_000);
  });

  it('ships a backlog over several batches in queue order', async () => {
    const ids = Array.from({ length: 2_500 }, (_, index) => `row-${index}`);
    await main.transaction((tx) =>
      service().recordManyInTransaction(
        tx,
        ids.map((id) => entry(id)),
      ),
    );

    await drainAuditOutbox(main);

    const rows = await main
      .select({ resourceId: auditLog.resourceId })
      .from(auditLog)
      .orderBy(auditLog.seq);
    expect(rows.map((row) => row.resourceId)).toEqual(ids);
    await expectLinearChain(ids.length);
  });
});

describe('audit_log write-once guards (real PG)', () => {
  beforeEach(async () => {
    await main.transaction((tx) => service().recordInTransaction(tx, entry('guarded')));
    await drainAuditOutbox(main);
  });

  const statements = {
    UPDATE: sql`UPDATE audit_log SET action = 'rewritten'`,
    DELETE: sql`DELETE FROM audit_log`,
    TRUNCATE: sql`TRUNCATE audit_log`,
  };

  for (const [op, statement] of Object.entries(statements)) {
    it(`refuses ${op} for the table owner`, async () => {
      await expect(main.execute(statement)).rejects.toMatchObject({
        cause: { message: expect.stringContaining(`append-only: ${op}`) },
      });
      expect(await count('audit_log')).toBe(1);
    });

    it(`refuses ${op} with session_replication_role = replica`, async () => {
      await expect(
        main.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          await tx.execute(statement);
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining(`append-only: ${op}`) },
      });
      expect(await count('audit_log')).toBe(1);
    });
  }
});

describe('audit migrate guards (real PG)', () => {
  it('builds the unique chain indexes valid, and the triggers fire always', async () => {
    await migrate(db.url);

    const { rows: indexes } = await main.execute<{ name: string; valid: boolean; def: string }>(
      sql`SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('audit_log_seq_key', 'audit_log_event_id_key', 'audit_log_prev_hash_key')
          ORDER BY c.relname`,
    );
    expect(indexes.map(({ name, valid }) => ({ name, valid }))).toEqual([
      { name: 'audit_log_event_id_key', valid: true },
      { name: 'audit_log_prev_hash_key', valid: true },
      { name: 'audit_log_seq_key', valid: true },
    ]);
    expect(indexes.every(({ def }) => def.startsWith('CREATE UNIQUE INDEX'))).toBe(true);
    expect(indexes.find(({ name }) => name === 'audit_log_prev_hash_key')?.def).toContain(
      'NULLS NOT DISTINCT',
    );
    const { rows: triggers } = await main.execute<{ name: string; enabled: string }>(
      sql`SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
          WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers).toEqual([
      { name: 'audit_log_append_only', enabled: 'A' },
      { name: 'audit_log_no_truncate', enabled: 'A' },
    ]);
  });

  it('stops on a forked chain and names the fork, instead of deduping it', async () => {
    const fork = await createTestDb([migrateOutbox, migrate]);
    try {
      await fork.drizzle.db.execute(sql`DROP INDEX audit_log_prev_hash_key`);
      await fork.drizzle.db.transaction((tx) => enqueueAuditInTransaction(tx, entry('head')));
      await drainAuditOutbox(fork.drizzle.db);
      const [head] = await fork.drizzle.db.select().from(auditLog);
      await fork.drizzle.db.insert(auditLog).values({
        ...head!,
        id: randomUUID(),
        seq: head!.seq + 1,
        eventId: null,
        hash: randomUUID(),
      });

      await expect(migrate(fork.url)).rejects.toThrow(
        /hash chain is forked: 2 rows follow prev_hash/,
      );
      const { rows } = await fork.drizzle.db.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_log`,
      );
      expect(rows[0]?.n).toBe(2);
    } finally {
      await fork.drop();
    }
  });
});
