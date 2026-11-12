import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { withAuditGuardsLifted } from '../../testing/audit-guards.js';
import { auditOutbox, auditOutboxRejected, type DrizzleDb } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { makeEventBus, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { auditRecordFor } from '../plugin.js';
import { auditLog } from '../schema/index.js';
import {
  AuditService,
  appendAuditEntries,
  auditEventId,
  enqueueAuditInTransaction,
  type RecordInput,
} from '../service/audit.service.js';
import {
  AuditShipper,
  auditOutboxBacklog,
  drainAuditOutbox,
  shipAuditBatch,
} from '../service/audit-shipper.service.js';

let db: TestDb;
let main: DrizzleDb;

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

async function count(table: 'audit_log' | 'audit_outbox' | 'audit_outbox_rejected') {
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
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await withAuditGuardsLifted(main, (tx) =>
    tx.execute(sql`TRUNCATE audit_log, audit_outbox, audit_outbox_rejected RESTART IDENTITY`),
  );
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
    const occurredAt = new Date().toISOString();
    const queue = () =>
      main.transaction((tx) => enqueueAuditInTransaction(tx, entry('once'), eventId, occurredAt));

    await queue();
    await queue();
    expect(await count('audit_outbox')).toBe(1);
    await drainAuditOutbox(main);
    await queue();
    await drainAuditOutbox(main);

    expect(await count('audit_log')).toBe(1);
    expect(await count('audit_outbox')).toBe(0);
    expect(await count('audit_outbox_rejected')).toBe(0);
    const [row] = await main.select().from(auditLog);
    expect(row?.eventId).toBe(eventId);
    expect(row?.createdAt.toISOString()).toBe(occurredAt);
  });

  it('chains an event once when the tap and the consumer both queue it, apart in time', async () => {
    const envelope = {
      eventId: randomUUID(),
      correlationId: 'corr',
      occurredAt: new Date().toISOString(),
    };
    const payload = { roleId: randomUUID(), actorId: randomUUID(), before: [], after: [] };
    const queue = async () => {
      const record = await auditRecordFor('iam.role.permissions.changed', payload, envelope);
      await main.transaction((tx) =>
        enqueueAuditInTransaction(tx, record!, envelope.eventId, envelope.occurredAt),
      );
    };

    await queue();
    await drainAuditOutbox(main);
    await main.execute(sql`SELECT pg_sleep(0.01)`);
    await queue();
    await drainAuditOutbox(main);

    expect(await count('audit_log')).toBe(1);
    expect(await count('audit_outbox')).toBe(0);
    expect(await count('audit_outbox_rejected')).toBe(0);
  });

  it('dedups an event whose id is not a uuid under the same derived uuid', async () => {
    const occurredAt = new Date().toISOString();
    const queue = () =>
      main.transaction((tx) =>
        enqueueAuditInTransaction(tx, entry('broker'), '1700000000000-0', occurredAt),
      );

    await queue();
    await drainAuditOutbox(main);
    await queue();
    await drainAuditOutbox(main);

    const rows = await main.select({ eventId: auditLog.eventId }).from(auditLog);
    expect(rows).toEqual([{ eventId: auditEventId('1700000000000-0') }]);
    expect(rows[0]?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(await count('audit_outbox_rejected')).toBe(0);
  });

  it('stamps a record written through the port now, whatever time key it carries', async () => {
    const backdated = { ...entry('backdated'), occurredAt: '2000-01-01T00:00:00.000Z' };
    const before = Date.now();

    await service().record(backdated);
    await main.transaction((tx) => service().recordInTransaction(tx, backdated));
    await drainAuditOutbox(main);

    const rows = await main.select({ createdAt: auditLog.createdAt }).from(auditLog);
    expect(rows).toHaveLength(2);
    for (const { createdAt } of rows) {
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('records a role permission change, whose snapshots are arrays, through the outbox', async () => {
    const before = [{ resource: 'player', level: 'read' }];
    const after = [{ resource: 'player', level: 'read_write' }];
    const record = await auditRecordFor(
      'iam.role.permissions.changed',
      { roleId: randomUUID(), actorId: randomUUID(), before, after },
      undefined,
    );

    await main.transaction((tx) => enqueueAuditInTransaction(tx, record!));
    await drainAuditOutbox(main);

    const [row] = await main.select().from(auditLog);
    expect(row).toMatchObject({ action: 'iam.role.permissions.changed', before, after });
    expect(await count('audit_outbox_rejected')).toBe(0);
    await expectLinearChain(1);
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
    await main.transaction((tx) => appendAuditEntries(tx, queued));
    expect(await count('audit_outbox')).toBe(3);

    expect(await shipAuditBatch(main)).toBe(3);

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
      expect(await shipAuditBatch(main)).toBeNull();
      expect(await count('audit_log')).toBe(0);
    } finally {
      await release();
    }

    expect(await shipAuditBatch(main)).toBe(1);
    await expectLinearChain(1);
  });

  it('keeps one linear chain with 2k entries from concurrent writers and two shippers', async () => {
    const shippers = [
      new AuditShipper(main, { intervalMs: 5 }),
      new AuditShipper(main, { intervalMs: 5 }),
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

describe('audit shipper on a bad row (real PG)', () => {
  it('moves a row that fails its schema aside and ships the rows around it', async () => {
    await main.transaction((tx) => service().recordInTransaction(tx, entry('before')));
    const poisonId = randomUUID();
    const poison = { ...entry('poison'), actorType: 'robot', createdAt: 'yesterday' };
    // Past enqueue's own check, as a row written by an older or foreign writer would be.
    await main.insert(auditOutbox).values({ eventId: poisonId, entry: poison });
    await main.transaction((tx) => service().recordInTransaction(tx, entry('after')));

    await drainAuditOutbox(main);

    const shipped = await main
      .select({ resourceId: auditLog.resourceId })
      .from(auditLog)
      .orderBy(auditLog.seq);
    expect(shipped.map(({ resourceId }) => resourceId)).toEqual(['before', 'after']);
    expect(await count('audit_outbox')).toBe(0);
    const rejected = await main.select().from(auditOutboxRejected);
    expect(rejected).toEqual([
      expect.objectContaining({
        eventId: poisonId,
        entry: poison,
        error: expect.stringContaining('actorType'),
      }),
    ]);
    await expectLinearChain(2);
  });

  it('moves an entry aside, not deletes it, when a forged chain row holds its event id', async () => {
    const eventId = randomUUID();
    await main.transaction((tx) =>
      appendAuditEntries(tx, [
        {
          eventId,
          entry: { ...entry('forged'), correlationId: null, createdAt: new Date().toISOString() },
        },
      ]),
    );
    await main.transaction((tx) => enqueueAuditInTransaction(tx, entry('real'), eventId));

    await drainAuditOutbox(main);

    const chained = await main.select({ resourceId: auditLog.resourceId }).from(auditLog);
    expect(chained).toEqual([{ resourceId: 'forged' }]);
    expect(await count('audit_outbox')).toBe(0);
    const rejected = await main.select().from(auditOutboxRejected);
    expect(rejected).toEqual([
      expect.objectContaining({
        eventId,
        entry: expect.objectContaining({ resourceId: 'real', after: { resourceId: 'real' } }),
        error: 'event_id already chained with different content',
      }),
    ]);
  });

  it('moves aside an entry dated year 0, which Postgres cannot store, and ships the rest', async () => {
    const yearZero = {
      ...entry('year-zero'),
      correlationId: null,
      createdAt: '0000-06-15T00:00:00.000Z',
    };
    await main.insert(auditOutbox).values({ eventId: randomUUID(), entry: yearZero });
    await main.transaction((tx) => service().recordInTransaction(tx, entry('after')));

    await drainAuditOutbox(main);

    const chained = await main.select({ resourceId: auditLog.resourceId }).from(auditLog);
    expect(chained).toEqual([{ resourceId: 'after' }]);
    expect(await count('audit_outbox')).toBe(0);
    const rejected = await main.select().from(auditOutboxRejected);
    expect(rejected).toEqual([
      expect.objectContaining({ entry: yearZero, error: expect.stringContaining('year 0') }),
    ]);
  });

  it('keeps both of two different entries rejected under one event id', async () => {
    const eventId = randomUUID();
    for (const bad of [{ bad: 1 }, { bad: 2 }]) {
      await main.insert(auditOutbox).values({ eventId, entry: bad });
      await drainAuditOutbox(main);
    }

    expect(await count('audit_outbox')).toBe(0);
    const rejected = await main
      .select({ eventId: auditOutboxRejected.eventId, entry: auditOutboxRejected.entry })
      .from(auditOutboxRejected)
      .orderBy(auditOutboxRejected.outboxId);
    expect(rejected).toEqual([
      { eventId, entry: { bad: 1 } },
      { eventId, entry: { bad: 2 } },
    ]);
  });

  it('reports the backlog: rows waiting, the age of the oldest, and rows moved aside', async () => {
    expect(await auditOutboxBacklog(main)).toEqual({
      pending: 0,
      oldestPendingAgeMs: null,
      rejected: 0,
    });
    await main.insert(auditOutbox).values({ eventId: randomUUID(), entry: { bad: true } });
    await main.execute(sql`SELECT pg_sleep(0.05)`);
    await main.transaction((tx) => service().recordInTransaction(tx, entry('waiting')));

    const backlog = await auditOutboxBacklog(main);
    expect(backlog).toMatchObject({ pending: 2, rejected: 0 });
    expect(backlog.oldestPendingAgeMs).toBeGreaterThanOrEqual(50);

    await drainAuditOutbox(main);
    expect(await auditOutboxBacklog(main)).toEqual({
      pending: 0,
      oldestPendingAgeMs: null,
      rejected: 1,
    });
  });
});

describe('audit outbox guards (real PG)', () => {
  let queuedId: string;

  beforeEach(async () => {
    queuedId = randomUUID();
    await main.transaction((tx) => enqueueAuditInTransaction(tx, entry('queued'), queuedId));
  });

  it('refuses UPDATE and TRUNCATE, with session_replication_role = replica too', async () => {
    for (const replica of [false, true]) {
      for (const [op, statement] of [
        ['UPDATE', sql`UPDATE audit_outbox SET entry = '{}'::jsonb`],
        ['TRUNCATE', sql`TRUNCATE audit_outbox`],
      ] as const) {
        await expect(
          main.transaction(async (tx) => {
            if (replica) {
              await tx.execute(sql`SET LOCAL session_replication_role = replica`);
            }
            await tx.execute(statement);
          }),
        ).rejects.toMatchObject({
          cause: { message: expect.stringContaining(`audit_outbox is append-only: ${op}`) },
        });
      }
    }
    expect(await count('audit_outbox')).toBe(1);
  });

  it('refuses DELETE of a row that is neither chained nor rejected', async () => {
    await expect(
      main.delete(auditOutbox).where(eq(auditOutbox.eventId, queuedId)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('neither chained nor rejected') },
    });
    expect(await count('audit_outbox')).toBe(1);
  });

  it('refuses DELETE of a row whose id is forged into the chain or the rejected table', async () => {
    const [queued] = await main.select().from(auditOutbox);
    await main.insert(auditOutboxRejected).values({
      outboxId: queued!.id,
      eventId: queuedId,
      entry: {},
      error: 'forged',
      createdAt: queued!.createdAt,
    });
    await main.transaction((tx) =>
      appendAuditEntries(tx, [
        {
          eventId: queuedId,
          entry: { ...entry('forged'), correlationId: null, createdAt: new Date().toISOString() },
        },
      ]),
    );

    await expect(
      main.delete(auditOutbox).where(eq(auditOutbox.eventId, queuedId)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('neither chained nor rejected') },
    });
    expect(await count('audit_outbox')).toBe(1);
  });

  it('lets the shipper delete a row once its record is in the chain', async () => {
    await main.transaction(async (tx) => {
      const queued = await tx.select().from(auditOutbox);
      await appendAuditEntries(tx, queued);
      await tx.delete(auditOutbox).where(eq(auditOutbox.eventId, queuedId));
    });

    expect(await count('audit_outbox')).toBe(0);
    expect(await count('audit_log')).toBe(1);
  });

  it('keeps rejected rows append-only', async () => {
    await main.insert(auditOutbox).values({ eventId: randomUUID(), entry: { bad: true } });
    await drainAuditOutbox(main);
    expect(await count('audit_outbox_rejected')).toBe(1);

    for (const [op, statement] of [
      ['UPDATE', sql`UPDATE audit_outbox_rejected SET error = 'fixed'`],
      ['DELETE', sql`DELETE FROM audit_outbox_rejected`],
      ['TRUNCATE', sql`TRUNCATE audit_outbox_rejected`],
    ] as const) {
      await expect(main.execute(statement)).rejects.toMatchObject({
        cause: {
          message: expect.stringContaining(`audit_outbox_rejected is append-only: ${op}`),
        },
      });
    }
    expect(await count('audit_outbox_rejected')).toBe(1);
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
          WHERE tgrelid IN ('audit_log'::regclass, 'audit_outbox'::regclass,
                            'audit_outbox_rejected'::regclass)
            AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers).toEqual(
      [
        'audit_log_append_only',
        'audit_log_no_truncate',
        'audit_outbox_no_truncate',
        'audit_outbox_no_update',
        'audit_outbox_rejected_append_only',
        'audit_outbox_rejected_no_truncate',
        'audit_outbox_shipped_delete',
      ].map((name) => ({ name, enabled: 'A' })),
    );
    const { rows: functions } = await main.execute<{ name: string; config: string[] | null }>(
      sql`SELECT proname AS name, proconfig AS config FROM pg_proc
          WHERE proname IN ('audit_log_deny_mutation', 'audit_outbox_entry_chained',
                            'audit_outbox_deny_unshipped_delete')
          ORDER BY proname`,
    );
    expect(functions).toEqual(
      [
        'audit_log_deny_mutation',
        'audit_outbox_deny_unshipped_delete',
        'audit_outbox_entry_chained',
      ].map((name) => ({ name, config: ['search_path=pg_catalog, public'] })),
    );
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
