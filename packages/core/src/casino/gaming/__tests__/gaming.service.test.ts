import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import type { GameAdapter } from '@openora/core/contracts';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

describe('GamingService domain errors', () => {
  it('GameNotFoundError carries the id', () => {
    const err = new GameNotFoundError('game-abc');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameNotFoundError');
    expect(err.message).toContain('game-abc');
  });

  it('GameRoundNotFoundError carries the id', () => {
    const err = new GameRoundNotFoundError('round-xyz');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameRoundNotFoundError');
    expect(err.message).toContain('round-xyz');
  });
});

function makeQueryChain(rows: unknown[]) {
  const calls = { where: undefined as unknown };
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return chain;
    }),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  return { chain, calls };
}

const noopEvents = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
const noopAdapter = mock<GameAdapter>({});

describe('GamingService lobby', () => {
  it('listGames returns the active games', async () => {
    const query = makeQueryChain([
      {
        id: 'g1',
        name: 'Aces',
        provider: 'mock',
        category: 'slots',
        thumbnailUrl: null,
        isActive: true,
        metadata: null,
      },
    ]);
    const drizzle = mockDb(query.chain);
    const svc = new GamingService(drizzle, noopEvents, noopAdapter);

    const games = await svc.listGames();

    expect(games).toHaveLength(1);
    expect(query.chain.select).toHaveBeenCalledOnce();
    expect(query.chain.where).toHaveBeenCalledOnce();
    expect(query.calls.where).toBeDefined();
  });
});
