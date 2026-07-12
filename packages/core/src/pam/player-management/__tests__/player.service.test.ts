import { describe, it, expect, vi } from 'vitest';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

type DayCountRow = { date: string; n: number };

function chain(result: unknown): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: (v: unknown) => unknown) => res(result);
      }
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

// Chainable proxy that captures the first non-undefined argument passed to .where()
function makeCapturingChain(results: unknown[]): { proxy: any; captured: { where: unknown[] } } {
  const captured = { where: [] as unknown[] };
  let callIdx = 0;
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const result = results[callIdx++ % results.length];
        return (res: (v: unknown) => unknown) => res(result);
      }
      if (prop === 'where') {
        return (clause: unknown) => {
          captured.where.push(clause);
          return proxy;
        };
      }
      return () => proxy;
    },
    apply: () => proxy,
  });
  return { proxy, captured };
}

function makeService(dayCounts: DayCountRow[] = []): PlayerService {
  const db = { select: vi.fn(() => chain(dayCounts)) };
  const writer = { setStatus: vi.fn() } as never;
  return new PlayerService({ db } as never, writer);
}

describe('PlayerService domain errors', () => {
  it('PlayerNotFoundError carries the playerId', () => {
    const err = new PlayerNotFoundError('p-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlayerNotFoundError');
    expect(err.message).toContain('p-123');
  });
});

describe('PlayerService.remove', () => {
  function makeRemoveService(existing: unknown[]) {
    const setArgs: unknown[] = [];
    const update = vi.fn(() => ({
      set: vi.fn((patch: unknown) => {
        setArgs.push(patch);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    }));
    const db = { select: vi.fn(() => chain(existing)), update };
    const svc = new PlayerService({ db } as never, { setStatus: vi.fn() } as never);
    return { svc, db, setArgs };
  }

  it('soft-deletes by closing the player, never deletes the row', async () => {
    const { svc, db, setArgs } = makeRemoveService([{ id: 'p-1' }]);
    const result = await svc.remove('p-1');
    expect(result).toEqual({ success: true });
    expect(setArgs).toEqual([{ status: 'closed' }]);
    expect((db as { delete?: unknown }).delete).toBeUndefined();
  });

  it('throws PlayerNotFoundError when the player does not exist', async () => {
    const { svc } = makeRemoveService([]);
    await expect(svc.remove('missing')).rejects.toThrow(PlayerNotFoundError);
  });
});

describe('PlayerService.getByUserId', () => {
  it('throws PlayerNotFoundError when no player owns the userId', async () => {
    const db = { select: vi.fn(() => chain([])) };
    const svc = new PlayerService({ db } as never, { setStatus: vi.fn() } as never);
    await expect(svc.getByUserId('u-missing')).rejects.toThrow(PlayerNotFoundError);
  });
});

describe('PlayerService.registrationsOverTime', () => {
  it('returns one zero-filled bucket per day in the window', async () => {
    const svc = makeService([]);
    const points = await svc.registrationsOverTime(7);
    expect(points).toHaveLength(7);
    expect(points.every((p) => p.count === 0)).toBe(true);
    const dates = points.map((p) => p.date);
    expect(new Set(dates).size).toBe(7);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('places the DB day-count into its matching day bucket', async () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const svc = makeService([{ date: todayKey, n: 3 }]);
    const points = await svc.registrationsOverTime(7);
    const today = points.find((p) => p.date === todayKey);
    expect(today?.count).toBe(3);
    expect(points.filter((p) => p.date !== todayKey).every((p) => p.count === 0)).toBe(true);
  });
});

describe('PlayerService.list tag filter', () => {
  const emptyPlayerRow = {
    player: {
      id: 'p-1',
      userId: 'u-1',
      displayName: 'Player',
      status: 'active',
      kycStatus: 'pending',
      level: 1,
      totalWagered: '0',
      totalDeposits: '0',
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    email: 'p@test.com',
    tags: [],
  };

  it('applies a WHERE clause when tags are provided', async () => {
    const { proxy, captured } = makeCapturingChain([[emptyPlayerRow], [{ n: 0 }]]);
    const db = { select: vi.fn(() => proxy) };
    const svc = new PlayerService({ db } as never, { setStatus: vi.fn() } as never);

    await svc.list({ page: 1, limit: 20, tags: ['self_excluded', 'kyc_rejected'] }).catch(() => {});

    // At least one .where() call must have received a non-undefined clause
    expect(captured.where.some((c) => c !== undefined)).toBe(true);
  });

  it('applies no WHERE clause when tags are absent', async () => {
    const { proxy, captured } = makeCapturingChain([[emptyPlayerRow], [{ n: 0 }]]);
    const db = { select: vi.fn(() => proxy) };
    const svc = new PlayerService({ db } as never, { setStatus: vi.fn() } as never);

    await svc.list({ page: 1, limit: 20 }).catch(() => {});

    // All .where() calls should receive undefined when no filter is active
    expect(captured.where.every((c) => c === undefined)).toBe(true);
  });

  it('applies no WHERE clause when tags is an empty array', async () => {
    const { proxy, captured } = makeCapturingChain([[emptyPlayerRow], [{ n: 0 }]]);
    const db = { select: vi.fn(() => proxy) };
    const svc = new PlayerService({ db } as never, { setStatus: vi.fn() } as never);

    await svc.list({ page: 1, limit: 20, tags: [] }).catch(() => {});

    expect(captured.where.every((c) => c === undefined)).toBe(true);
  });
});
