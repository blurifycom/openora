import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  type AdminGameReporting,
  type GameCurrencyRanking,
  type GameCurrencyRankingFilter,
  type GameType,
  type RunContext,
} from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameProvider, gameRound } from '../schema/index.js';
import gamingPlugin from '../plugin.js';

let db: TestDb;

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
const IN_RANGE = new Date('2026-01-10T12:00:00.000Z');

/** Boots the gaming tools; `report` rebinds ADMIN_GAME_REPORTING as an operator's overlay would. */
function bootKernel(report?: AdminGameReporting) {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('gaming');
  gamingPlugin.register(registry);
  if (report) {
    container.register(ADMIN_GAME_REPORTING, () => report);
  }
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'top-games-tool',
});

async function seedGame(name: string, gameType: GameType = 'casino') {
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: `${name} Studio` })
      .returning(),
    new Error('seedGame: no provider'),
  );
  return findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name,
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'direct',
        gameType,
        reviewStatus: 'approved',
      })
      .returning(),
    new Error('seedGame: no game'),
  );
}

async function seedRound(
  gameId: string,
  values: Partial<typeof gameRound.$inferInsert> & { betAmount: string },
) {
  await db.drizzle.db.insert(gameRound).values({
    gameId,
    userId: randomUUID(),
    status: 'completed',
    winAmount: '0',
    currency: 'USD',
    startedAt: IN_RANGE,
    ...values,
  });
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('gaming.top_games through the MCP kernel (real PG)', () => {
  it('ranks the games per currency over the completed rounds of whole UTC days', async () => {
    const kernel = bootKernel();
    const [aces, blaze, comet] = [
      await seedGame('Aces'),
      await seedGame('Blaze'),
      await seedGame('Comet'),
    ];
    const regular = randomUUID();
    await seedRound(aces.id, { betAmount: '100', winAmount: '30', userId: regular });
    await seedRound(aces.id, { betAmount: '50', winAmount: '0', userId: regular });
    // The last millisecond of dateTo counts; the first of the next day does not.
    await seedRound(blaze.id, {
      betAmount: '300',
      winAmount: '400',
      startedAt: new Date('2026-01-31T23:59:59.999Z'),
    });
    await seedRound(blaze.id, {
      betAmount: '999',
      startedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await seedRound(comet.id, { betAmount: '10' });
    await seedRound(comet.id, { betAmount: '999', status: 'active' });
    await seedRound(aces.id, { betAmount: '7', winAmount: '2', currency: 'EUR' });

    const result = await kernel.invokeTool(
      'gaming.top_games',
      { ...RANGE, limit: 2 },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        sortBy: 'volume',
        sortDir: 'desc',
        currencies: [
          {
            currency: 'EUR',
            totals: expect.objectContaining({ roundsPlayed: 1, uniquePlayers: 1, gamesPlayed: 1 }),
            games: [expect.objectContaining({ gameId: aces.id, roundsPlayed: 1 })],
          },
          {
            currency: 'USD',
            totals: {
              volume: expect.stringMatching(/^460(\.0+)?$/),
              revenue: expect.stringMatching(/^30(\.0+)?$/),
              roundsPlayed: 4,
              uniquePlayers: 3,
              gamesPlayed: 3,
            },
            games: [
              {
                gameId: blaze.id,
                name: 'Blaze',
                provider: 'Blaze Studio',
                gameType: 'casino',
                volume: expect.any(String),
                revenue: expect.any(String),
                roundsPlayed: 1,
                uniquePlayers: 1,
              },
              expect.objectContaining({ gameId: aces.id, roundsPlayed: 2, uniquePlayers: 1 }),
            ],
          },
        ],
        truncated: false,
      },
    });
  });

  it('lists the biggest losers first by revenue ascending, narrowed by game type', async () => {
    const kernel = bootKernel();
    const [winner, loser, sportsbook] = [
      await seedGame('Winner'),
      await seedGame('Loser'),
      await seedGame('Book', 'sportsbook'),
    ];
    await seedRound(winner.id, { betAmount: '100', winAmount: '10' });
    await seedRound(loser.id, { betAmount: '100', winAmount: '500' });
    await seedRound(sportsbook.id, { betAmount: '100', winAmount: '900' });

    const result = await kernel.invokeTool(
      'gaming.top_games',
      { ...RANGE, sortBy: 'revenue', sortDir: 'asc', gameType: 'casino', currency: 'usd' },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        currencies: [
          {
            currency: 'USD',
            totals: { gamesPlayed: 2 },
            games: [
              { gameId: loser.id, revenue: expect.stringMatching(/^-400(\.0+)?$/) },
              { gameId: winner.id },
            ],
          },
        ],
      },
    });
  });

  it("ranks by the operator's rebound game report, and is unavailable when it cannot rank", async () => {
    const unread = () => Promise.reject(new Error('gaming.top_games reads only the ranking'));
    const operatorReport = {
      listGamePerformance: unread,
      getGamePerformanceTrend: unread,
      getPlayerStats: unread,
    } satisfies AdminGameReporting;
    const asked: GameCurrencyRankingFilter[] = [];
    const ranking: GameCurrencyRanking = {
      currencies: [
        {
          currency: 'EUR',
          totals: {
            volume: '80.000000000000000000',
            revenue: '-20.000000000000000000',
            roundsPlayed: 4,
            uniquePlayers: 2,
            gamesPlayed: 1,
          },
          games: [
            {
              gameId: randomUUID(),
              name: 'Warehouse Aces',
              provider: 'Warehouse Studio',
              gameType: 'casino',
              volume: '80.000000000000000000',
              revenue: '-20.000000000000000000',
              roundsPlayed: 4,
              uniquePlayers: 2,
            },
          ],
        },
      ],
      truncated: false,
    };
    const ranked = bootKernel({
      ...operatorReport,
      rankGamesPerCurrency: (filter) => {
        asked.push(filter);
        return Promise.resolve(ranking);
      },
    });
    const input = { ...RANGE, currency: 'eur', sortBy: 'revenue', sortDir: 'asc', limit: 3 };

    expect(await ranked.invokeTool('gaming.top_games', input, runContext())).toEqual({
      ok: true,
      output: { ...RANGE, sortBy: 'revenue', sortDir: 'asc', ...ranking },
    });
    expect(asked).toEqual([
      {
        dateFrom: new Date('2026-01-01T00:00:00.000Z'),
        dateTo: new Date('2026-01-31T23:59:59.999Z'),
        currency: 'EUR',
        sortBy: 'revenue',
        sortDir: 'asc',
        limit: 3,
        maxCurrencies: 20,
      },
    ]);
    expect(
      await bootKernel(operatorReport).invokeTool('gaming.top_games', RANGE, runContext()),
    ).toMatchObject({ ok: false, error: 'report_unavailable' });
  });

  it('refuses a range over 92 days and a limit over 50', async () => {
    const kernel = bootKernel();

    for (const input of [
      { dateFrom: '2026-01-01', dateTo: '2026-04-03' },
      { dateFrom: '2026-02-01', dateTo: '2026-01-31' },
      { limit: 51 },
    ]) {
      expect(await kernel.invokeTool('gaming.top_games', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});
