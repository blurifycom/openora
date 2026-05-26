import { describe, it, expect, vi } from 'vitest';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

type DateRow = { createdAt: Date };

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

function makeService(playerRows: DateRow[] = []): PlayerService {
  const db = { select: vi.fn(() => chain(playerRows)) };
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

  it('counts a registration into its day bucket', async () => {
    const today = new Date();
    const svc = makeService([{ createdAt: today }]);
    const points = await svc.registrationsOverTime(7);
    const total = points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(1);
  });
});
