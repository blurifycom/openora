import { describe, it, expect } from 'vitest';
import { PlayerService, PlayerNotFoundError, ForbiddenError } from '../service/player.service.js';

type DateRow = { createdAt: Date };

function makeService(playerRows: DateRow[] = []): PlayerService {
  // Minimal Prisma stub - only the methods exercised by these unit tests.
  const prisma = {
    player: {
      findMany: async () => playerRows,
      count: async () => playerRows.length,
    },
    user: { findUnique: async () => null },
  } as unknown as ConstructorParameters<typeof PlayerService>[0];
  return new PlayerService(prisma);
}

describe('PlayerService domain errors', () => {
  it('PlayerNotFoundError carries the playerId', () => {
    const err = new PlayerNotFoundError('p-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlayerNotFoundError');
    expect(err.message).toContain('p-123');
  });

  it('ForbiddenError defaults to admin-access message', () => {
    const err = new ForbiddenError();
    expect(err.name).toBe('ForbiddenError');
    expect(err.message).toMatch(/admin/i);
  });
});

describe('PlayerService.registrationsOverTime', () => {
  it('returns one zero-filled bucket per day in the window', async () => {
    const svc = makeService([]);
    const points = await svc.registrationsOverTime(7);
    expect(points).toHaveLength(7);
    expect(points.every((p) => p.count === 0)).toBe(true);
    // dates are ascending, unique, YYYY-MM-DD
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
