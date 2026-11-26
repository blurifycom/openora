import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { auditOutbox, auditOutboxRejected } from '@openora/core/server';
import { migrate as migrateEngine } from '@openora/core/server/migrate';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { migrate as migrateAudit } from '../../migrate.js';
import { auditLog } from '../../schema/index.js';
import { auditOutboxBacklog, drainAuditOutbox } from '../audit-shipper.service.js';
import {
  computeHash,
  enqueueAuditInTransaction,
  verifyAuditChain,
  type RecordInput,
} from '../audit.service.js';

const opened: TestDb[] = [];

afterEach(async () => {
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
  action: `test.chain.${randomUUID()}`,
  resourceType: 'test',
  resourceId: randomUUID(),
  after: { note: randomUUID() },
  ...overrides,
});

async function appendRows(db: Db, count: number) {
  await db.transaction(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      await enqueueAuditInTransaction(tx, entry());
    }
  });
  await drainAuditOutbox(db);
}

const chainRows = (db: Db) => db.select().from(auditLog).orderBy(asc(auditLog.seq));

const withTriggersOff = async (db: Db, fn: () => Promise<unknown>) => {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
  try {
    await fn();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only`);
  }
};

const hashOf = (row: typeof auditLog.$inferSelect) =>
  computeHash({
    id: row.id,
    actorId: row.actorId,
    actorType: row.actorType,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: row.before,
    after: row.after,
    result: row.result,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    prevHash: row.prevHash,
  });

describe('append-only hash chain', () => {
  it('the first row has sequence 1 and an empty previous hash', async () => {
    const db = await freshChain();
    await appendRows(db, 1);

    const [first, ...rest] = await chainRows(db);

    expect(rest).toHaveLength(0);
    expect(first?.seq).toBe(1);
    expect(first?.prevHash).toBeNull();
  });

  it('each next row stores the previous row hash and the next sequence', async () => {
    const db = await freshChain();
    await appendRows(db, 4);

    const rows = await chainRows(db);

    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    for (const [index, row] of rows.entries()) {
      expect(row.prevHash).toBe(rows[index - 1]?.hash ?? null);
    }
  });

  it('concurrent appends produce a gap-free sequence with an unbroken chain', async () => {
    const db = await freshChain();

    await Promise.all(Array.from({ length: 8 }, () => appendRows(db, 3)));

    const rows = await chainRows(db);
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(rows.map((row) => row.prevHash)).size).toBe(24);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
  });

  it('verifying an untouched chain reports ok', async () => {
    const db = await freshChain();
    await appendRows(db, 5);

    expect(await verifyAuditChain(db)).toEqual({ valid: true });
  });

  it('verifying a chain whose row content was edited reports the first broken sequence', async () => {
    const db = await freshChain();
    await appendRows(db, 4);
    const rows = await chainRows(db);
    const target = rows[1];
    if (!target) {
      throw new Error('missing row');
    }

    await withTriggersOff(db, () =>
      db.update(auditLog).set({ action: 'tampered.action' }).where(eq(auditLog.id, target.id)),
    );

    expect(await verifyAuditChain(db)).toEqual({
      valid: false,
      firstBrokenSeq: target.seq,
      rowId: target.id,
    });
  });

  it('verifying a chain whose row was deleted reports the break', async () => {
    const db = await freshChain();
    await appendRows(db, 4);
    const rows = await chainRows(db);
    const [, removed, next] = rows;
    if (!removed || !next) {
      throw new Error('missing rows');
    }

    await withTriggersOff(db, () => db.delete(auditLog).where(eq(auditLog.id, removed.id)));

    expect(await verifyAuditChain(db)).toEqual({
      valid: false,
      firstBrokenSeq: next.seq,
      rowId: next.id,
    });
  });

  it('verifying a chain whose hash was rewritten reports a mismatch with the next row', async () => {
    const db = await freshChain();
    await appendRows(db, 4);
    const rows = await chainRows(db);
    const [, target, next] = rows;
    if (!target || !next) {
      throw new Error('missing rows');
    }
    const forged = { ...target, action: 'forged.action' };

    await withTriggersOff(db, () =>
      db
        .update(auditLog)
        .set({ action: forged.action, hash: hashOf(forged) })
        .where(eq(auditLog.id, target.id)),
    );

    expect(await verifyAuditChain(db)).toEqual({
      valid: false,
      firstBrokenSeq: next.seq,
      rowId: next.id,
    });
  });

  it('updating or deleting an audit row is refused by the database', async () => {
    const db = await freshChain();
    await appendRows(db, 2);
    const [row] = await chainRows(db);
    if (!row) {
      throw new Error('missing row');
    }

    await expect(
      db.update(auditLog).set({ action: 'tampered.action' }).where(eq(auditLog.id, row.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('append-only') } });
    await expect(db.delete(auditLog).where(eq(auditLog.id, row.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining('append-only') },
    });
    await expect(db.execute(sql`TRUNCATE audit_log`)).rejects.toMatchObject({
      cause: { message: expect.stringContaining('append-only') },
    });
    expect(await chainRows(db)).toHaveLength(2);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
  });

  it('a row written with jsonb keys in a different order still verifies', async () => {
    const db = await freshChain();
    await db.transaction(async (tx) => {
      await enqueueAuditInTransaction(
        tx,
        entry({
          before: { zeta: 1, alpha: { yy: 2, b: 3 }, list: [{ y: 1, x: 2 }, 3] },
          after: { longer_key: 'a', k: 'b', nested: { z: 1, a: 2 } },
        }),
      );
    });
    await drainAuditOutbox(db);

    const [row] = await chainRows(db);

    expect(Object.keys(row?.before ?? {})).not.toEqual(['zeta', 'alpha', 'list']);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
  });

  it('a rejected entry in a batch does not break the chain of the accepted ones', async () => {
    const db = await freshChain();
    const malformedEventId = randomUUID();
    await db.transaction(async (tx) => {
      await enqueueAuditInTransaction(tx, entry());
      await tx
        .insert(auditOutbox)
        .values({ eventId: malformedEventId, entry: { action: '', actorType: 'nobody' } });
      await enqueueAuditInTransaction(tx, entry());
      await enqueueAuditInTransaction(tx, entry());
    });

    await drainAuditOutbox(db);

    const rows = await chainRows(db);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(await verifyAuditChain(db)).toEqual({ valid: true });
    const rejected = await db.select().from(auditOutboxRejected);
    expect(rejected.map((row) => row.eventId)).toEqual([malformedEventId]);
    expect(await auditOutboxBacklog(db)).toMatchObject({ pending: 0, rejected: 1 });
  });

  it('an audited write rolls back with its business transaction and leaves no row', async () => {
    const db = await freshChain();
    const action = `test.rollback.${randomUUID()}`;

    await expect(
      db.transaction(async (tx) => {
        await enqueueAuditInTransaction(tx, entry({ action }));
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    await drainAuditOutbox(db);

    expect(await chainRows(db)).toHaveLength(0);
    expect(await auditOutboxBacklog(db)).toMatchObject({ pending: 0, rejected: 0 });
  });
});
