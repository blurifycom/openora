import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import type { GameAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameRound } from '../schema/index.js';
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

let db: TestDb;

const noopEvents = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
const noopAdapter = mock<GameAdapter>({});

function makeService() {
  return new GamingService(db.drizzle, noopEvents, noopAdapter);
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(game)
    .values({ name: 'Game', provider: 'mock', category: 'slots', ...overrides })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameRound}, ${game} RESTART IDENTITY CASCADE`);
});

describe('GamingService lobby (real PG)', () => {
  it('listGames returns only active games, ordered by name', async () => {
    await seedGame({ name: 'Baccarat', isActive: true });
    await seedGame({ name: 'Aces', isActive: true });
    await seedGame({ name: 'Retired', isActive: false });

    const games = await makeService().listGames();

    expect(games.map((g) => g.name)).toEqual(['Aces', 'Baccarat']);
  });

  it('getGame returns the row for a known id and 404s an unknown one', async () => {
    const created = await seedGame({ name: 'Roulette', category: 'table' });
    const svc = makeService();

    expect(await svc.getGame(created.id)).toMatchObject({ name: 'Roulette', category: 'table' });
    await expect(svc.getGame('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
  });
});
