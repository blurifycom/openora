import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider, gameRound } from '../schema/index.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';

let db: TestDb;
let reporting: DrizzleAdminGameReporting;

const AT = (iso: string) => new Date(iso);

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Test Studio' })
    .returning();
  const [category] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Slots' })
    .returning();
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Aces',
      slug: `game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      ...overrides,
    })
    .returning();
  await db.drizzle.db
    .insert(gameCategoryGame)
    .values({ gameId: row!.id, categoryId: category!.id });
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
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
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

  it('limits rows to gameIds, keeping a listed game with no rounds and returning none for an empty list', async () => {
    const played = await seedGame({ name: 'Played' });
    const idle = await seedGame({ name: 'Idle' });
    const other = await seedGame({ name: 'Other' });
    await seedRound(played.id);
    await seedRound(other.id);

    const rows = await reporting.listGamePerformance({ gameIds: [played.id, idle.id] });

    expect(new Map(rows.map((r) => [r.gameId, r.roundsPlayed]))).toEqual(
      new Map([
        [played.id, 1],
        [idle.id, 0],
      ]),
    );
    expect(await reporting.listGamePerformance({ gameIds: [] })).toEqual([]);
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

describe('DrizzleAdminGameReporting.rankGamesByRounds (real PG)', () => {
  const range = {
    dateFrom: AT('2026-01-01T00:00:00.000Z'),
    dateTo: AT('2026-01-31T00:00:00.000Z'),
  };

  it('ranks the listed games by completed rounds in range, most first, ties by id, up to the limit', async () => {
    const [busy, tieA, tieB, quiet, unlisted] = [
      await seedGame(),
      await seedGame(),
      await seedGame(),
      await seedGame(),
      await seedGame(),
    ];
    for (let i = 0; i < 3; i += 1) {
      await seedRound(busy.id);
      await seedRound(unlisted.id);
    }
    await seedRound(tieA.id);
    await seedRound(tieB.id);
    await seedRound(quiet.id, { status: 'active' });
    await seedRound(quiet.id, { startedAt: AT('2025-12-31T00:00:00.000Z') });
    const [first, second] = [tieA.id, tieB.id].sort();
    const gameIds = [busy.id, tieA.id, tieB.id, quiet.id];

    expect(await reporting.rankGamesByRounds({ ...range, gameIds, limit: 10 })).toEqual([
      { gameId: busy.id, roundsPlayed: 3 },
      { gameId: first, roundsPlayed: 1 },
      { gameId: second, roundsPlayed: 1 },
    ]);
    expect(await reporting.rankGamesByRounds({ ...range, gameIds, limit: 2 })).toEqual([
      { gameId: busy.id, roundsPlayed: 3 },
      { gameId: first, roundsPlayed: 1 },
    ]);
    expect(await reporting.rankGamesByRounds({ ...range, gameIds: [], limit: 10 })).toEqual([]);
  });
});

describe('DrizzleAdminGameReporting.getGamePerformanceTrend (real PG)', () => {
  const JAN = {
    dateFrom: AT('2026-01-05T00:00:00.000Z'),
    dateTo: AT('2026-01-25T23:59:59.999Z'),
  };

  it('buckets completed rounds by ISO week and sums the points into the totals', async () => {
    const g = await seedGame();
    const player = randomUUID();
    await seedRound(g.id, {
      userId: player,
      betAmount: '100',
      winAmount: '40',
      startedAt: AT('2026-01-05T00:00:00.000Z'),
    });
    await seedRound(g.id, {
      userId: player,
      betAmount: '50',
      winAmount: '0',
      startedAt: AT('2026-01-11T23:59:59.000Z'),
    });
    await seedRound(g.id, {
      betAmount: '30',
      winAmount: '10',
      startedAt: AT('2026-01-21T12:00:00.000Z'),
    });
    await seedRound(g.id, {
      status: 'active',
      betAmount: '999',
      startedAt: AT('2026-01-21T12:00:00.000Z'),
    });
    await seedRound(g.id, { betAmount: '999', startedAt: AT('2026-01-26T00:00:00.000Z') });

    const trend = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'week',
      ...JAN,
    });

    expect(
      trend?.points.map((p) => [p.bucket, Number(p.volume), Number(p.revenue), p.roundsPlayed]),
    ).toEqual([
      ['2026-01-05', 150, 110, 2],
      ['2026-01-12', 0, 0, 0],
      ['2026-01-19', 30, 20, 1],
    ]);
    expect(trend?.totals).toMatchObject({ uniquePlayers: 2, roundsPlayed: 3 });
    expect(Number(trend?.totals.volume)).toBe(180);
    expect(Number(trend?.totals.revenue)).toBe(130);
  });

  it('truncates buckets in UTC by day and by month', async () => {
    const g = await seedGame();
    await seedRound(g.id, { betAmount: '10', startedAt: AT('2026-01-31T23:30:00.000Z') });
    await seedRound(g.id, { betAmount: '20', startedAt: AT('2026-02-01T00:30:00.000Z') });
    const range = {
      dateFrom: AT('2026-01-31T00:00:00.000Z'),
      dateTo: AT('2026-02-01T23:59:59.000Z'),
    };

    const daily = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'day',
      ...range,
    });
    const monthly = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'month',
      ...range,
    });

    expect(daily?.points.map((p) => [p.bucket, Number(p.volume)])).toEqual([
      ['2026-01-31', 10],
      ['2026-02-01', 20],
    ]);
    expect(monthly?.points.map((p) => [p.bucket, Number(p.volume)])).toEqual([
      ['2026-01-01', 10],
      ['2026-02-01', 20],
    ]);
  });

  it('returns zero totals and a zero-filled series for a game with no activity', async () => {
    const g = await seedGame();
    const other = await seedGame({ name: 'Busy' });
    await seedRound(other.id, { startedAt: AT('2026-01-10T00:00:00.000Z') });

    const trend = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'week',
      ...JAN,
    });

    expect(trend?.totals).toMatchObject({ uniquePlayers: 0, roundsPlayed: 0 });
    expect(Number(trend?.totals.volume)).toBe(0);
    expect(Number(trend?.totals.revenue)).toBe(0);
    expect(trend?.points).toHaveLength(3);
    expect(trend?.points.every((p) => p.roundsPlayed === 0 && Number(p.volume) === 0)).toBe(true);
  });

  it('keeps revenue negative in the bucket and the totals when a game pays out more than it takes', async () => {
    const g = await seedGame();
    await seedRound(g.id, {
      betAmount: '10',
      winAmount: '100',
      startedAt: AT('2026-01-06T00:00:00.000Z'),
    });

    const trend = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'week',
      ...JAN,
    });

    expect(Number(trend?.points[0]?.revenue)).toBe(-90);
    expect(Number(trend?.totals.revenue)).toBe(-90);
  });

  it('scopes rounds to the currency when one is given and sums unconverted without one', async () => {
    const g = await seedGame();
    await seedRound(g.id, {
      betAmount: '100',
      currency: 'USD',
      startedAt: AT('2026-01-06T00:00:00.000Z'),
    });
    await seedRound(g.id, {
      betAmount: '50',
      currency: 'EUR',
      startedAt: AT('2026-01-06T00:00:00.000Z'),
    });

    const usd = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'week',
      currency: 'USD',
      ...JAN,
    });
    const mixed = await reporting.getGamePerformanceTrend({
      gameId: g.id,
      granularity: 'week',
      ...JAN,
    });

    expect(usd?.totals.roundsPlayed).toBe(1);
    expect(Number(usd?.totals.volume)).toBe(100);
    expect(Number(usd?.points[0]?.volume)).toBe(100);
    expect(Number(mixed?.totals.volume)).toBe(150);
  });

  it('returns null for an unknown game', async () => {
    await expect(
      reporting.getGamePerformanceTrend({ gameId: randomUUID(), granularity: 'week', ...JAN }),
    ).resolves.toBeNull();
  });
});
