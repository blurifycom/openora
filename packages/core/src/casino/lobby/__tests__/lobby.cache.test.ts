import { describe, it, expect, vi } from 'vitest';
import { mockDb } from '../../../testing/mock.js';
import { InProcessCache } from '@blurifycom/core/server';
import { LobbyService } from '../service/lobby.service.js';

function makeDb(slotRows: unknown[], gameRows: unknown[]) {
  const featuredChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(slotRows),
  };
  const gameChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(gameRows),
  };
  let selectCallIndex = 0;
  const select = vi.fn(() => {
    selectCallIndex++;
    return selectCallIndex % 2 === 1 ? featuredChain : gameChain;
  });
  return { select };
}

describe('LobbyService featured cache', () => {
  it('serves the second read within the ttl from cache without re-querying', async () => {
    const slotRow = { id: 's1', title: 'Big Win', gameId: 'g1', placement: 'home', sortOrder: 0 };
    const gameRow = { id: 'g1', name: 'Aces', thumbnailUrl: 'aces.png' };

    const db = makeDb([slotRow], [gameRow]);
    const cache = new InProcessCache();
    const svc = new LobbyService(mockDb(db), cache);

    const first = await svc.getFeatured();
    const second = await svc.getFeatured();

    expect(second).toEqual(first);
    expect(first).toEqual([
      {
        id: 's1',
        title: 'Big Win',
        gameId: 'g1',
        gameName: 'Aces',
        thumbnailUrl: 'aces.png',
        placement: 'home',
        sortOrder: 0,
      },
    ]);
    expect(db.select).toHaveBeenCalledTimes(2);

    cache.close();
  });
});
