import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { game, gameRound } from '../schema/index.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';

let db: TestDb;
let reporting: DrizzleAdminGameReporting;

const AT = (iso: string) => new Date(iso);

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(game)
    .values({ name: 'Aces', provider: 'p', category: 'slots', ...overrides })
    .returning();
  return row!;
}

async function seedRound(gameId: string, overrides: Partial<typeof gameRound.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameRound)
    .values({
      gameId,
      userId: randomUUID(),
      status: 'completed',
      betAmount: '100',
      winAmount: '0',
      currency: 'USD',
      startedAt: AT('2026-01-01T00:00:00.000Z'),
      ...overrides,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  reporting = new DrizzleAdminGameReporting(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameRound}, ${game} RESTART IDENTITY CASCADE`);
});

describe('DrizzleAdminGameReporting.listGamePerformance (real PG)', () => {
  it('sums volume/revenue and counts distinct players/rounds for completed rounds', async () => {
    const g = await seedGame();
    await seedRound(g.id, { betAmount: '100', winAmount: '20' });
    await seedRound(g.id, { betAmount: '50', winAmount: '80' });

    const [row] = await reporting.listGamePerformance({});

    expect(row).toMatchObject({
      gameId: g.id,
      name: 'Aces',
      gameType: 'casino',
      uniquePlayers: 2,
      roundsPlayed: 2,
    });
    expect(Number(row?.volume)).toBe(150);
    expect(Number(row?.revenue)).toBe(50);
  });

  it('keeps revenue negative when a game pays out more than it takes in (GGR can go negative)', async () => {
    const g = await seedGame();
    await seedRound(g.id, { betAmount: '10', winAmount: '100' });

    const [row] = await reporting.listGamePerformance({});

    expect(Number(row?.revenue)).toBe(-90);
  });

  it('still lists a game with zero completed rounds in range, with all-zero metrics', async () => {
    const g = await seedGame({ name: 'Empty' });
    await seedRound(g.id, { status: 'active' });

    const [row] = await reporting.listGamePerformance({});

    expect(row).toMatchObject({ gameId: g.id, uniquePlayers: 0, roundsPlayed: 0 });
    expect(Number(row?.volume)).toBe(0);
    expect(Number(row?.revenue)).toBe(0);
  });

  it('ignores non-completed rounds when summing metrics', async () => {
    const g = await seedGame();
    await seedRound(g.id, { status: 'active', betAmount: '999' });
    await seedRound(g.id, { status: 'cancelled', betAmount: '999' });
    const counted = await seedRound(g.id, { status: 'completed', betAmount: '10' });

    const [row] = await reporting.listGamePerformance({});

    expect(row?.roundsPlayed).toBe(1);
    expect(Number(row?.volume)).toBe(10);
    void counted;
  });

  it('filters by gameType, dropping non-matching games entirely', async () => {
    const casino = await seedGame({ gameType: 'casino' });
    await seedGame({ gameType: 'sportsbook' });

    const rows = await reporting.listGamePerformance({ gameType: 'sportsbook' });

    expect(rows.map((r) => r.gameId)).not.toContain(casino.id);
  });

  it('scopes rounds by dateFrom/dateTo without dropping the game', async () => {
    const g = await seedGame();
    await seedRound(g.id, { betAmount: '10', startedAt: AT('2025-01-01T00:00:00.000Z') });
    await seedRound(g.id, { betAmount: '20', startedAt: AT('2026-01-15T00:00:00.000Z') });

    const [row] = await reporting.listGamePerformance({
      dateFrom: AT('2026-01-01T00:00:00.000Z'),
      dateTo: AT('2026-02-01T00:00:00.000Z'),
    });

    expect(row?.roundsPlayed).toBe(1);
    expect(Number(row?.volume)).toBe(20);
  });

  it('scopes rounds by currency without dropping the game or mixing currencies', async () => {
    const g = await seedGame();
    await seedRound(g.id, { betAmount: '100', currency: 'USD' });
    await seedRound(g.id, { betAmount: '50', currency: 'EUR' });

    const [row] = await reporting.listGamePerformance({ currency: 'USD' });

    expect(row?.roundsPlayed).toBe(1);
    expect(Number(row?.volume)).toBe(100);
  });

  it('sorts by the requested column and direction', async () => {
    const low = await seedGame({ name: 'Low' });
    const high = await seedGame({ name: 'High' });
    await seedRound(low.id, { betAmount: '10' });
    await seedRound(high.id, { betAmount: '100' });

    const rows = await reporting.listGamePerformance({ sortBy: 'volume', sortDir: 'asc' });

    expect(rows.map((r) => r.gameId)).toEqual([low.id, high.id]);
  });

  it('defaults to sorting by volume descending when sortBy is omitted', async () => {
    const low = await seedGame({ name: 'Low' });
    const high = await seedGame({ name: 'High' });
    await seedRound(low.id, { betAmount: '10' });
    await seedRound(high.id, { betAmount: '100' });

    const rows = await reporting.listGamePerformance({});

    expect(rows.map((r) => r.gameId)).toEqual([high.id, low.id]);
  });
});
