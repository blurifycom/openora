import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AuditService } from '../service/audit.service.js';

function computeHash(fields: {
  id: string;
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

function makeEvents(): import('@blurifycom/core/server').EventBus {
  return { emit: vi.fn(), on: vi.fn() } as unknown as import('@blurifycom/core/server').EventBus;
}

const CREATED_AT = new Date('2024-01-01T00:00:00.000Z');

function makeRow(
  overrides: {
    id?: string;
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

function makeDrizzleWithSelectQueue(
  ...selectResults: Array<() => Promise<unknown[]>>
): import('@blurifycom/core/server').DrizzleService {
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
      };
      (chain.orderBy as ReturnType<typeof vi.fn>).mockImplementation(function () {
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
  return { db } as unknown as import('@blurifycom/core/server').DrizzleService;
}

function makeManualDrizzle(
  db: Record<string, unknown>,
): import('@blurifycom/core/server').DrizzleService {
  return { db } as unknown as import('@blurifycom/core/server').DrizzleService;
}

function makeChainStore() {
  const rows: ReturnType<typeof makeRow>[] = [];
  let seqCounter = 0;
  let executeCall = 0;

  const tx = {
    execute: vi.fn().mockImplementation(() => {
      const call = executeCall++;
      if (call % 2 === 1) {
        seqCounter += 1;
        return Promise.resolve({ rows: [{ seq: seqCounter }] });
      }
      return Promise.resolve({ rows: [{}] });
    }),
    select: vi.fn().mockImplementation(() => {
      const chain = {
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          const latest = rows[rows.length - 1];
          return Promise.resolve(latest ? [{ hash: latest.hash }] : []);
        }),
      };
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: ReturnType<typeof makeRow>) => ({
        returning: vi.fn().mockImplementation(() => {
          rows.push(vals);
          return Promise.resolve([vals]);
        }),
      })),
    })),
  };

  const db = {
    transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return { drizzle: makeManualDrizzle(db), tx, getRows: () => rows };
}

describe('AuditService.record()', () => {
  it('inserts with prevHash=null for the first row and stores a real sha256 hash (no UPDATE)', async () => {
    const store = makeChainStore();
    const svc = new AuditService(store.drizzle, makeEvents());

    const result = await svc.record({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });

    expect(result.prevHash).toBeNull();

    const expected = computeHash({
      id: result.id,
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
    expect('update' in store.tx).toBe(false);
  });

  it('chains prevHash from the latest existing row across sequential appends', async () => {
    const store = makeChainStore();
    const svc = new AuditService(store.drizzle, makeEvents());

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
    expect(first.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(2);

    const persisted = store.getRows();
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
    expect(await verifySvc.verifyChain()).toEqual({ valid: true });
  });
});

describe('AuditService.verifyChain()', () => {
  function makeVerifyDb(rows: ReturnType<typeof makeRow>[]) {
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
    expect(await svc.verifyChain()).toEqual({ valid: true });
  });

  it('returns valid:true when hash chain is intact across two rows', async () => {
    const hash1 = computeHash({
      id: 'r1',
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
    expect(await svc.verifyChain()).toEqual({ valid: true });
  });

  it('detects a tampered row - wrong hash value', async () => {
    const rows = [makeRow({ id: 'r1', seq: 1, prevHash: null, hash: 'tampered-wrong-hash' })];

    const svc = new AuditService(makeVerifyDb(rows), makeEvents());
    const result = await svc.verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe('r1');
      expect(result.firstBrokenSeq).toBe(1);
    }
  });

  it('detects a broken prevHash link between rows', async () => {
    const hash1 = computeHash({
      id: 'r1',
      actorId: null,
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
      resourceId: null,
      seq: 1,
      createdAt: CREATED_AT.toISOString(),
      prevHash: null,
    });

    const rows = [
      makeRow({ id: 'r1', seq: 1, prevHash: null, hash: hash1 }),
      makeRow({ id: 'r2', seq: 2, prevHash: 'wrong-prev-hash', hash: 'anything' }),
    ];

    const svc = new AuditService(makeVerifyDb(rows), makeEvents());
    const result = await svc.verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe('r2');
      expect(result.firstBrokenSeq).toBe(2);
    }
  });
});

describe('AuditService.list()', () => {
  function makeListDb(rows: ReturnType<typeof makeRow>[], count: number) {
    let selectCall = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        const call = selectCall++;
        if (call === 0) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            offset: vi.fn().mockResolvedValueOnce(rows),
          };
        }
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
    const result = await svc.list({ page: 3, limit: 10 });

    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(50);
  });
});

describe('AuditService.exportCsv()', () => {
  function makeExportDb(rows: ReturnType<typeof makeRow>[]) {
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
    expect(lines[0]).toContain('hash');
  });

  it('includes correct field values in data rows', async () => {
    const rows = [makeRow({ actorId: 'u1', actorType: 'player' })];
    const svc = new AuditService(makeExportDb(rows), makeEvents());
    const csv = await svc.exportCsv({});

    expect(csv).toContain('row-1');
    expect(csv).toContain('player');
  });

  it('escapes double-quotes in field values', async () => {
    const rows = [makeRow({ action: 'has "quotes"' })];
    const svc = new AuditService(makeExportDb(rows), makeEvents());
    const csv = await svc.exportCsv({});

    expect(csv).toContain('has ""quotes""');
  });
});
