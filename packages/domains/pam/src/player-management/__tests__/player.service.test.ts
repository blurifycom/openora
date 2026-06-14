import { describe, it, expect, vi } from 'vitest';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

// Day-count rows as returned by the DB GROUP BY (aggregation happens in SQL,
// not in the service), eg { date: '2026-06-09', n: 1 }.
type DayCountRow = { date: string; n: number };

function chain(result: unknown): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(result);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function makeService(dayCounts: DayCountRow[] = []): PlayerService {
  const db = { select: vi.fn(() => chain(dayCounts)) };
  return new PlayerService({ db } as never);
}

describe('PlayerService domain errors', () => {
  it('PlayerNotFoundError carries the playerId', () => {
    const err = new PlayerNotFoundError('p-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlayerNotFoundError');
    expect(err.message).toContain('p-123');
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
    // days with no DB row stay zero-filled
    expect(points.filter((p) => p.date !== todayKey).every((p) => p.count === 0)).toBe(true);
  });
});
