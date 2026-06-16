import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AuditService } from '../service/audit.service.js';

// ---------------------------------------------------------------------------
// Hash helper - mirrors the private one in the service exactly
// ---------------------------------------------------------------------------

function computeHash(fields: {
  id: string;
  tenantId: string;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  seq: number;
  createdAt: string;
  prevHash: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: fields.id,
        tenantId: fields.tenantId,
        actorId: fields.actorId,
        actorType: fields.actorType,
        action: fields.action,
        resourceType: fields.resourceType,
        resourceId: fields.resourceId,
        seq: fields.seq,
        createdAt: fields.createdAt,
        prevHash: fields.prevHash ?? '',
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Drizzle mock factories
// record() now runs inside db.transaction(tx => ...) and issues, in order:
//   1. tx.execute(SELECT pg_advisory_xact_lock(...))   (serialize per tenant)
//   2. tx.select..where..orderBy..limit                (read chain tip)
//   3. tx.execute(SELECT nextval(...))                 (reserve seq)
//   4. tx.insert..values..returning                    (single final-hash insert)
// There is NO update - the row is inserted with its real hash.
//
// For list() it runs two parallel queries via Promise.all:
//   A. select..from..where..orderBy..limit..offset  (rows)
//   B. select..from..where                          (count)
//
// For exportCsv() / verifyChain():
//   select..from..where..orderBy  (all rows, ordered)
// ---------------------------------------------------------------------------

function makeEvents(): import('@oss/core/server').EventBus {
  return { emit: vi.fn(), on: vi.fn() } as unknown as import('@oss/core/server').EventBus;
}

const TENANT = 'tenant-test';
const CREATED_AT = new Date('2024-01-01T00:00:00.000Z');

function makeRow(
  overrides: {
    id?: string;
    tenantId?: string;
    actorId?: string | null;
    actorType?: 'player' | 'admin' | 'system';
    action?: string;
    resourceType?: string;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
    correlationId?: string | null;
    seq?: number;
    prevHash?: string | null;
    hash?: string;
    createdAt?: Date;
  } = {},
) {
  return {
    id: 'row-1',
    tenantId: TENANT,
    actorId: null,
    actorType: 'system' as const,
    action: 'identity.user.registered',
    resourceType: 'identity',
    resourceId: null,
    before: null,
    after: null,
    ip: null,
    userAgent: null,
    correlationId: null,
    seq: 1,
    prevHash: null,
    hash: 'deadbeef',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

// Build a Drizzle mock whose `select()` returns a fresh chain object each call.
// Each chain queues responses via `mockResolvedValueOnce` on the terminal method.
// `callIndex` lets callers configure which call returns what.
function makeDrizzleWithSelectQueue(
  ...selectResults: Array<() => Promise<unknown[]>>
): import('@oss/core/server').DrizzleService {
  let callCount = 0;
  const db = {
    select: vi.fn().mockImplementation(() => {
      const idx = callCount++;
      const resolver = selectResults[idx] ?? (() => Promise.resolve([]));
      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockImplementation(() => resolver()),
        // Some queries don't call offset - resolve at orderBy or where instead.
      };
      // Make orderBy and where also potentially terminal (used by verifyChain / exportCsv).
      // The last chained call resolves. We detect "no further call" by checking
      // whether offset gets called; if not, fall through to orderBy / where.
      (chain.orderBy as ReturnType<typeof vi.fn>).mockImplementation(function () {
        // Return a thenable that resolves unless offset is called next.
        const result = resolver();
        const thenableChain = {
          ...chain,
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            result.then(resolve, reject),
          offset: vi.fn().mockImplementation(() => resolver()),
          limit: vi.fn().mockReturnThis(),
        };
        (thenableChain.limit as ReturnType<typeof vi.fn>).mockReturnValue(thenableChain);
        return thenableChain;
      });
      return chain;
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  };
  return { db } as unknown as import('@oss/core/server').DrizzleService;
}

// Simpler mock for scenarios where we control exact call sequences manually.
function makeManualDrizzle(db: Record<string, unknown>): import('@oss/core/server').DrizzleService {
  return { db } as unknown as import('@oss/core/server').DrizzleService;
}

// ---------------------------------------------------------------------------
// record() - atomic single-insert, advisory-locked, hash chaining
// ---------------------------------------------------------------------------

// A persistent in-memory store of audit rows keyed by tenant, with a shared seq
// counter that stands in for the DB serial sequence. Builds a Drizzle mock whose
// `transaction(cb)` runs cb against a `tx` handle that:
//   - tx.execute(advisory lock)  -> no-op resolve
//   - tx.execute(nextval)        -> increments and returns the shared seq
//   - tx.select(...tip...)       -> returns the latest row hash for the tenant
//   - tx.insert(...).returning() -> appends the row and returns it
// No update method is provided, so any UPDATE attempt throws.
function makeChainStore() {
  const rowsByTenant = new Map<string, ReturnType<typeof makeRow>[]>();
  let seqCounter = 0;
  let executeCall = 0;

  const tx = {
    execute: vi.fn().mockImplementation(() => {
      // Order within a record() tx: 1st execute = advisory lock, 2nd = nextval.
      const call = executeCall++;
      if (call % 2 === 1) {
        // nextval
        seqCounter += 1;
        return Promise.resolve({ rows: [{ seq: seqCounter }] });
      }
      // advisory lock
      return Promise.resolve({ rows: [{}] });
    }),
    select: vi.fn().mockImplementation(() => {
      // Captures the tenant from .where() then resolves at .limit().
      let tenant: string | undefined;
      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation((cond: { __tenant?: string }) => {
          tenant = cond?.__tenant;
          return chain;
        }),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          const rows = rowsByTenant.get(tenant ?? '') ?? [];
          const latest = rows[rows.length - 1];
          return Promise.resolve(latest ? [{ hash: latest.hash }] : []);
        }),
      };
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: ReturnType<typeof makeRow>) => ({
        returning: vi.fn().mockImplementation(() => {
          const list = rowsByTenant.get(vals.tenantId) ?? [];
          list.push(vals);
          rowsByTenant.set(vals.tenantId, list);
          return Promise.resolve([vals]);
        }),
      })),
    })),
  };

  const db = {
    transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return { drizzle: makeManualDrizzle(db), tx, getRows: (t: string) => rowsByTenant.get(t) ?? [] };
}

// Override eq()'s shape so the select mock can read the tenant being filtered.
// The real eq returns an opaque SQL object; here we only need the value.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((col: unknown, val: unknown) => {
      // Tag tenant-equality so the mock select can route by tenant.
      const colName = (col as { name?: string })?.name;
      return colName === 'tenantId' ? { __tenant: val } : { col, val };
    }),
  };
});

describe('AuditService.record()', () => {
  it('inserts with prevHash=null for the first row and stores a real sha256 hash (no UPDATE)', async () => {
    const store = makeChainStore();
    const svc = new AuditService(store.drizzle, makeEvents());

    const result = await svc.record({
      tenantId: TENANT,
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });

    expect(result.tenantId).toBe(TENANT);
    expect(result.prevHash).toBeNull();

    const expected = computeHash({
      id: result.id,
      tenantId: result.tenantId,
      actorId: result.actorId,
      actorType: result.actorType,
      action: result.action,
      resourceType: result.resourceType,
      resourceId: result.resourceId,
      seq: result.seq,
      createdAt: result.createdAt,
      prevHash: null,
    });
    expect(result.hash).toBe(expected);
    expect(result.hash).not.toBe('pending');
    // The tx handle exposes no update method - the write path is INSERT only.
    expect('update' in store.tx).toBe(false);
  });

  it('chains prevHash from the latest existing row across sequential appends', async () => {
    const store = makeChainStore();
    const svc = new AuditService(store.drizzle, makeEvents());

    const first = await svc.record({
      tenantId: TENANT,
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    const second = await svc.record({
      tenantId: TENANT,
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });

    expect(first.prevHash).toBeNull();
    expect(first.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(2);

    // Run verifyChain over the produced rows: the chain must validate end to end,
    // proving no 'pending' hash leaked and the links are intact.
    const persisted = store.getRows(TENANT);
    const verifySvc = new AuditService(
      makeManualDrizzle({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValueOnce(persisted),
        }),
      }),
      makeEvents(),
    );
    expect(await verifySvc.verifyChain(TENANT)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// verifyChain()
// ---------------------------------------------------------------------------

describe('AuditService.verifyChain()', () => {
  function makeVerifyDb(rows: ReturnType<typeof makeRow>[]) {
    // verifyChain does: select().from().where().orderBy()
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValueOnce(rows),
      }),
    };
    return makeManualDrizzle(db);
  }

  it('returns valid:true for an empty chain', async () => {
    const svc = new AuditService(makeVerifyDb([]), makeEvents());
    expect(await svc.verifyChain(TENANT)).toEqual({ valid: true });
  });

  it('returns valid:true when hash chain is intact across two rows', async () => {
    const hash1 = computeHash({
      id: 'r1',
      tenantId: TENANT,
      actorId: null,
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
      resourceId: null,
      seq: 1,
      createdAt: CREATED_AT.toISOString(),
      prevHash: null,
    });
    const hash2 = computeHash({
      id: 'r2',
      tenantId: TENANT,
      actorId: null,
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
      resourceId: null,
      seq: 2,
      createdAt: CREATED_AT.toISOString(),
      prevHash: hash1,
    });

    const rows = [
      makeRow({ id: 'r1', seq: 1, prevHash: null, hash: hash1 }),
      makeRow({
        id: 'r2',
        seq: 2,
        action: 'wallet.deposit.completed',
        resourceType: 'wallet',
        prevHash: hash1,
        hash: hash2,
      }),
    ];

    const svc = new AuditService(makeVerifyDb(rows), makeEvents());
    expect(await svc.verifyChain(TENANT)).toEqual({ valid: true });
  });

  it('detects a tampered row - wrong hash value', async () => {
    const rows = [makeRow({ id: 'r1', seq: 1, prevHash: null, hash: 'tampered-wrong-hash' })];

    const svc = new AuditService(makeVerifyDb(rows), makeEvents());
    const result = await svc.verifyChain(TENANT);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe('r1');
      expect(result.firstBrokenSeq).toBe(1);
    }
  });

  it('detects a broken prevHash link between rows', async () => {
    // Row 1 has a valid hash.
    const hash1 = computeHash({
      id: 'r1',
      tenantId: TENANT,
      actorId: null,
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
      resourceId: null,
      seq: 1,
      createdAt: CREATED_AT.toISOString(),
      prevHash: null,
    });

    // Row 2 claims prevHash = 'wrong' (not hash1), making the link broken.
    const rows = [
      makeRow({ id: 'r1', seq: 1, prevHash: null, hash: hash1 }),
      makeRow({ id: 'r2', seq: 2, prevHash: 'wrong-prev-hash', hash: 'anything' }),
    ];

    const svc = new AuditService(makeVerifyDb(rows), makeEvents());
    const result = await svc.verifyChain(TENANT);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe('r2');
      expect(result.firstBrokenSeq).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('AuditService.list()', () => {
  function makeListDb(rows: ReturnType<typeof makeRow>[], count: number) {
    // list() runs Promise.all with two independent select chains.
    // We return different results per select() call index.
    let selectCall = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        const call = selectCall++;
        if (call === 0) {
          // Rows query: select..from..where..orderBy..limit..offset
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            offset: vi.fn().mockResolvedValueOnce(rows),
          };
        }
        // Count query: select..from..where
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValueOnce([{ count }]),
        };
      }),
    };
    return makeManualDrizzle(db);
  }

  it('returns paginated items with total', async () => {
    const rows = [makeRow(), makeRow({ id: 'row-2', seq: 2 })];
    const svc = new AuditService(makeListDb(rows, 2), makeEvents());
    const result = await svc.list({ page: 1, limit: 10 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('applies actorId filter and returns empty result when no match', async () => {
    const svc = new AuditService(makeListDb([], 0), makeEvents());
    const result = await svc.list({ actorId: 'user-xyz', page: 1, limit: 10 });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('respects page and limit for offset calculation', async () => {
    const svc = new AuditService(makeListDb([], 50), makeEvents());
    // page 3, limit 10 -> offset 20 (pageToOffset(3,10) = (3-1)*10 = 20)
    const result = await svc.list({ page: 3, limit: 10 });

    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// exportCsv()
// ---------------------------------------------------------------------------

describe('AuditService.exportCsv()', () => {
  function makeExportDb(rows: ReturnType<typeof makeRow>[]) {
    // exportCsv does: select().from().where().orderBy().limit()
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValueOnce(rows),
      }),
    };
    return makeManualDrizzle(db);
  }

  it('emits a header row followed by one data row per result', async () => {
    const rows = [
      makeRow({ actorId: 'u1', actorType: 'player' }),
      makeRow({ id: 'row-2', seq: 2 }),
    ];
    const svc = new AuditService(makeExportDb(rows), makeEvents());
    const csv = await svc.exportCsv({});

    const lines = csv.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3); // 1 header + 2 data
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('tenantId');
    expect(lines[0]).toContain('hash');
  });

  it('includes correct field values in data rows', async () => {
    const rows = [makeRow({ actorId: 'u1', actorType: 'player' })];
    const svc = new AuditService(makeExportDb(rows), makeEvents());
    const csv = await svc.exportCsv({});

    expect(csv).toContain('row-1');
    expect(csv).toContain(TENANT);
    expect(csv).toContain('player');
  });

  it('escapes double-quotes in field values', async () => {
    const rows = [makeRow({ action: 'has "quotes"' })];
    const svc = new AuditService(makeExportDb(rows), makeEvents());
    const csv = await svc.exportCsv({});

    expect(csv).toContain('has ""quotes""');
  });
});
