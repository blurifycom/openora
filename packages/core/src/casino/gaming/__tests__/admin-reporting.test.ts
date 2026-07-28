import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@openora/core/server';
import { mock } from '../../../testing/mock.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';

type Row = Record<string, unknown>;

function makeDrizzle(rows: Row[]) {
  const whereArgs: unknown[] = [];
  const orderByArgs: unknown[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['select'] = vi.fn(chain);
  builder['from'] = vi.fn(chain);
  builder['leftJoin'] = vi.fn(chain);
  builder['groupBy'] = vi.fn(chain);
  builder['orderBy'] = vi.fn((arg: unknown) => {
    orderByArgs.push(arg);
    return builder;
  });
  builder['where'] = vi.fn((arg: unknown) => {
    whereArgs.push(arg);
    return builder;
  });
  // oxlint-disable-next-line unicorn/no-thenable -- builder must be awaitable to mimic Drizzle.
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(rows);
  const db = { ...builder } as unknown;
  return { drizzle: mock<DrizzleService>({ db }), whereArgs, orderByArgs };
}

function row(over: Row = {}): Row {
  return {
    gameId: 'g-1',
    name: 'Aces',
    gameType: 'casino',
    volume: '1000',
    revenue: '200',
    uniquePlayers: '3',
    roundsPlayed: '10',
    ...over,
  };
}

describe('DrizzleAdminGameReporting.listGamePerformance', () => {
  it('maps rows and coerces count columns to numbers', async () => {
    const { drizzle } = makeDrizzle([row()]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    const rows = await reporting.listGamePerformance({});

    expect(rows).toEqual([
      {
        gameId: 'g-1',
        name: 'Aces',
        gameType: 'casino',
        volume: '1000',
        revenue: '200',
        uniquePlayers: 3,
        roundsPlayed: 10,
      },
    ]);
  });

  it('keeps a negative revenue string intact (GGR can go negative)', async () => {
    const { drizzle } = makeDrizzle([row({ revenue: '-50' })]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    const rows = await reporting.listGamePerformance({});

    expect(rows[0]?.revenue).toBe('-50');
  });

  it('adds a WHERE clause when gameType is filtered', async () => {
    const { drizzle, whereArgs } = makeDrizzle([]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    await reporting.listGamePerformance({ gameType: 'sportsbook' });

    expect(whereArgs).toEqual([expect.anything()]);
  });

  it('passes an undefined WHERE when no gameType filter is given', async () => {
    const { drizzle, whereArgs } = makeDrizzle([]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    await reporting.listGamePerformance({});

    expect(whereArgs).toEqual([undefined]);
  });

  it('sorts by the requested column and direction', async () => {
    const { drizzle, orderByArgs } = makeDrizzle([]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    await reporting.listGamePerformance({ sortBy: 'name', sortDir: 'asc' });

    expect(orderByArgs).toHaveLength(1);
  });

  it('defaults to a defined sort when sortBy is omitted', async () => {
    const { drizzle, orderByArgs } = makeDrizzle([]);
    const reporting = new DrizzleAdminGameReporting(drizzle);

    await reporting.listGamePerformance({});

    expect(orderByArgs).toHaveLength(1);
    expect(orderByArgs[0]).toBeDefined();
  });
});
