import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { auditLog } from '../schema/index.js';
import { AuditService, computeHash, startOfDayUtc, endOfDayUtc } from '../service/audit.service.js';
import { AuditListFiltersSchema } from '../contract/index.js';

describe('computeHash canonical form', () => {
  it('matches the frozen golden vector', () => {
    expect(
      computeHash({
        id: '11111111-1111-1111-1111-111111111111',
        actorId: null,
        actorType: 'system',
        action: 'test.action',
        resourceType: 'test',
        resourceId: null,
        before: null,
        after: null,
        result: null,
        seq: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        prevHash: null,
      }),
    ).toBe('4974d60531e6d9bd960f61a1d86371ac92aa12e31ec24ab3f61130aa6ee1f3ca');
  });

  it('changes when before/after/result differ - the mutation payload is in the chain', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      actorId: null,
      actorType: 'system' as const,
      action: 'test.action',
      resourceType: 'test',
      resourceId: null,
      seq: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      prevHash: null,
    };
    const unmodified = computeHash({ ...base, before: null, after: null, result: null });
    const tamperedAfter = computeHash({
      ...base,
      before: null,
      after: { role: 'admin' },
      result: null,
    });
    const tamperedResult = computeHash({ ...base, before: null, after: null, result: 'success' });

    expect(tamperedAfter).not.toBe(unmodified);
    expect(tamperedResult).not.toBe(unmodified);
  });

  it('is unaffected by nested before/after key order - jsonb round-tripping reorders keys', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      actorId: null,
      actorType: 'admin' as const,
      action: 'test.action',
      resourceType: 'test',
      resourceId: null,
      result: null,
      seq: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      prevHash: null,
    };

    const originalOrder = computeHash({
      ...base,
      before: { role: 'player', nested: { b: 2, a: 1 } },
      after: { nested: { b: 2, a: 1 }, role: 'admin' },
    });
    const reorderedKeys = computeHash({
      ...base,
      before: { nested: { a: 1, b: 2 }, role: 'player' },
      after: { role: 'admin', nested: { a: 1, b: 2 } },
    });

    expect(reorderedKeys).toBe(originalOrder);
  });
});

let db: TestDb;

function makeService() {
  return new AuditService(db.drizzle, makeEventBus());
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${auditLog} RESTART IDENTITY CASCADE`);
});

describe('AuditService.record() (real PG)', () => {
  it('inserts with prevHash=null for the first row and stores a real sha256 hash', async () => {
    const result = await makeService().record({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });

    expect(result.prevHash).toBeNull();
    expect(result.hash).toBe(
      computeHash({
        id: result.id,
        actorId: result.actorId ?? null,
        actorType: result.actorType,
        action: result.action,
        resourceType: result.resourceType,
        resourceId: result.resourceId ?? null,
        before: result.before ?? null,
        after: result.after ?? null,
        result: result.result ?? null,
        seq: result.seq,
        createdAt: result.createdAt,
        prevHash: null,
      }),
    );
    expect(result.hash).not.toBe('pending');
  });

  it('chains prevHash from the latest existing row across sequential appends', async () => {
    const svc = makeService();
    const first = await svc.record({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    const second = await svc.record({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect((await svc.verifyChain()).valid).toBe(true);
  });

  it('records the row a social.friend_request.sent branch would produce', async () => {
    const friendshipId = randomUUID();
    const requesterId = randomUUID();
    const addresseeId = randomUUID();

    const result = await makeService().record({
      actorType: 'player',
      actorId: requesterId,
      action: 'social.friend_request.sent',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { addresseeId, status: 'pending' },
      result: 'success',
    });

    expect(result).toMatchObject({
      actorType: 'player',
      actorId: requesterId,
      action: 'social.friend_request.sent',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { addresseeId, status: 'pending' },
      result: 'success',
    });
  });

  it('records the row a social.friend_request.accepted branch would produce', async () => {
    const friendshipId = randomUUID();
    const accepterId = randomUUID();

    const result = await makeService().record({
      actorType: 'player',
      actorId: accepterId,
      action: 'social.friend_request.accepted',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { status: 'accepted' },
      result: 'success',
    });

    expect(result).toMatchObject({
      actorType: 'player',
      actorId: accepterId,
      action: 'social.friend_request.accepted',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { status: 'accepted' },
      result: 'success',
    });
  });
});

describe('AuditService.verifyChain() (real PG)', () => {
  async function seedRow(input: Parameters<AuditService['record']>[0]) {
    return makeService().record(input);
  }

  it('returns valid:true for an empty chain', async () => {
    expect(await makeService().verifyChain()).toEqual({ valid: true });
  });

  it('returns valid:true when hash chain is intact across two rows', async () => {
    await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    await seedRow({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });

    expect(await makeService().verifyChain()).toEqual({ valid: true });
  });

  it('detects a tampered row - wrong hash value', async () => {
    const row = await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ hash: 'tampered-wrong-hash' })
      .where(eq(auditLog.id, row.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(row.id);
      expect(result.firstBrokenSeq).toBe(row.seq);
    }
  });

  it('detects a rewritten before/after/result - not just the id/action/actor fields', async () => {
    const row = await seedRow({
      actorId: 'admin-1',
      actorType: 'admin',
      action: 'admin.user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      before: { role: 'player' },
      after: { role: 'player' },
      result: 'success',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ after: { role: 'admin' } })
      .where(eq(auditLog.id, row.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(row.id);
    }
  });

  it('detects a broken prevHash link between rows', async () => {
    await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    const second = await seedRow({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ prevHash: 'wrong-prev-hash' })
      .where(eq(auditLog.id, second.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(second.id);
      expect(result.firstBrokenSeq).toBe(second.seq);
    }
  });
});

describe('AuditService.list() (real PG)', () => {
  async function seed(inputs: Parameters<AuditService['record']>[0][]) {
    const svc = makeService();
    for (const input of inputs) {
      await svc.record(input);
    }
  }

  it('returns paginated items with total', async () => {
    await seed([
      { actorType: 'system', action: 'a.one', resourceType: 'identity' },
      { actorType: 'system', action: 'a.two', resourceType: 'wallet' },
    ]);

    const result = await makeService().list({ page: 1, limit: 10 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('applies actorId filter and returns empty result when no match', async () => {
    await seed([{ actorId: 'someone', actorType: 'admin', action: 'a', resourceType: 'x' }]);

    const result = await makeService().list({ actorId: 'user-xyz', page: 1, limit: 10 });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('q matches a row by actorId', async () => {
    await seed([
      { actorId: 'subject-1', actorType: 'player', action: 'a', resourceType: 'x' },
      { actorId: 'other', actorType: 'player', action: 'a', resourceType: 'x' },
    ]);

    const result = await makeService().list({ q: 'subject-1', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.actorId).toBe('subject-1');
    expect(result.total).toBe(1);
  });

  it('q matches a row by resourceId', async () => {
    await seed([
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-9' },
    ]);

    const result = await makeService().list({ q: 'txn-9', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resourceId).toBe('txn-9');
    expect(result.total).toBe(1);
  });

  it('applies explicit resourceId filter', async () => {
    await seed([
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-42' },
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-99' },
    ]);

    const result = await makeService().list({ resourceId: 'txn-42', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resourceId).toBe('txn-42');
  });

  it('q combined with actorType still ANDs correctly', async () => {
    await seed([
      { actorId: 'subject-1', actorType: 'player', action: 'a', resourceType: 'x' },
      { actorId: 'subject-1', actorType: 'admin', action: 'a', resourceType: 'x' },
    ]);

    const result = await makeService().list({
      q: 'subject-1',
      actorType: 'player',
      page: 1,
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.actorType).toBe('player');
  });

  it('respects page and limit for offset calculation', async () => {
    await seed(
      Array.from({ length: 12 }, (_, i) => ({
        actorType: 'system' as const,
        action: `a.${i}`,
        resourceType: 'x',
      })),
    );

    const result = await makeService().list({ page: 2, limit: 10 });

    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(2);
  });
});

describe('audit date-range boundaries', () => {
  it('endOfDayUtc spans the whole day so toDate includes same-day entries', () => {
    const end = endOfDayUtc('2026-07-21');
    expect(end.toISOString()).toBe('2026-07-21T23:59:59.999Z');

    const lateEntry = new Date('2026-07-21T22:00:00.000Z');
    expect(lateEntry <= end).toBe(true);
  });

  it('startOfDayUtc anchors to midnight UTC', () => {
    expect(startOfDayUtc('2026-07-21').toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('list filters accept bare YYYY-MM-DD dates', () => {
    const parsed = AuditListFiltersSchema.safeParse({
      fromDate: '2026-07-01',
      toDate: '2026-07-21',
    });
    expect(parsed.success).toBe(true);
  });

  it('list filters reject a full timestamp so the day-boundary math cannot shift', () => {
    const parsed = AuditListFiltersSchema.safeParse({ toDate: '2026-07-21T22:00:00+05:00' });
    expect(parsed.success).toBe(false);
  });
});

describe('AuditService.exportCsv() (real PG)', () => {
  async function seed(inputs: Parameters<AuditService['record']>[0][]) {
    const svc = makeService();
    for (const input of inputs) {
      await svc.record(input);
    }
  }

  it('emits a header row followed by one data row per result', async () => {
    await seed([
      { actorId: 'u1', actorType: 'player', action: 'a.one', resourceType: 'identity' },
      { actorType: 'system', action: 'a.two', resourceType: 'wallet' },
    ]);

    const csv = await makeService().exportCsv({});
    const lines = csv.split('\n').filter(Boolean);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('hash');
  });

  it('includes correct field values in data rows', async () => {
    await seed([{ actorId: 'u1', actorType: 'player', action: 'a.one', resourceType: 'identity' }]);

    const csv = await makeService().exportCsv({});

    expect(csv).toContain('u1');
    expect(csv).toContain('player');
  });

  it('escapes double-quotes in field values', async () => {
    await seed([{ actorType: 'system', action: 'has "quotes"', resourceType: 'x' }]);

    const csv = await makeService().exportCsv({});

    expect(csv).toContain('has ""quotes""');
  });
});
