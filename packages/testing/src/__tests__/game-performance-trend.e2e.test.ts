import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { GamePerformanceTrendSchema } from '@openora/core/admin-console/contract';
import {
  asAdmin,
  asPlayer,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;
let player: TestClient;
let gameId: string;

const RANGE = 'dateFrom=2026-01-05T00:00:00.000Z&dateTo=2026-01-18T23:59:59.999Z';
const trendPath = (id: string, query: string) => `/backoffice/analytics/games/${id}/trend?${query}`;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 1 });
  admin = await asAdmin(testApp.app);
  player = await asPlayer(testApp.app, { email: 'player.1@demo.igaming.dev' });

  const drizzle = testApp.container.get(DRIZZLE).db;
  const [provider] = await drizzle
    .insert(gameProvider)
    .values({ slug: `trend-e2e-${randomUUID()}`, name: 'Trend E2E Studio' })
    .returning();
  const [created] = await drizzle
    .insert(game)
    .values({
      name: 'Trend E2E Game',
      slug: `trend-e2e-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
    })
    .returning();
  gameId = created!.id;
  await drizzle.insert(gameRound).values([
    {
      gameId,
      userId: randomUUID(),
      status: 'completed',
      betAmount: '100',
      winAmount: '30',
      currency: 'USD',
      startedAt: new Date('2026-01-06T10:00:00.000Z'),
    },
    {
      gameId,
      userId: randomUUID(),
      status: 'completed',
      betAmount: '20',
      winAmount: '50',
      currency: 'USD',
      startedAt: new Date('2026-01-14T10:00:00.000Z'),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('game performance trend API', () => {
  it('returns one game totals and weekly revenue in a single request', async () => {
    const response = await admin.get(trendPath(gameId, `${RANGE}&granularity=week&currency=USD`));
    expect(response.status).toBe(200);
    const trend = GamePerformanceTrendSchema.parse(await response.json());

    expect(trend.totals).toMatchObject({ uniquePlayers: 2, roundsPlayed: 2 });
    expect(Number(trend.totals.revenue)).toBe(40);
    expect(trend.points.map((p) => [p.bucket, Number(p.revenue), p.roundsPlayed])).toEqual([
      ['2026-01-05', 70, 1],
      ['2026-01-12', -30, 1],
    ]);
  });

  it('defaults dateFrom to 30 days before dateTo', async () => {
    const response = await admin.get(
      trendPath(gameId, 'dateTo=2026-01-18T23:59:59.999Z&granularity=day&currency=USD'),
    );
    expect(response.status).toBe(200);
    const trend = GamePerformanceTrendSchema.parse(await response.json());

    expect(trend.points).toHaveLength(31);
    expect(trend.points[0]?.bucket).toBe('2025-12-19');
    expect(trend.totals.roundsPlayed).toBe(2);
  });

  it('rejects a lone dateFrom that lands after the default dateTo of now', async () => {
    const response = await admin.get(
      trendPath(gameId, 'dateFrom=2999-01-01T00:00:00.000Z&granularity=week'),
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown game', async () => {
    const response = await admin.get(trendPath(randomUUID(), `${RANGE}&granularity=week`));
    expect(response.status).toBe(404);
  });

  it('rejects a range that spans more buckets than the cap', async () => {
    const response = await admin.get(
      trendPath(
        gameId,
        'dateFrom=2020-01-01T00:00:00.000Z&dateTo=2026-01-01T00:00:00.000Z&granularity=day',
      ),
    );
    expect(response.status).toBe(400);
  });

  it('denies the trend to a caller without report view permission', async () => {
    const response = await player.get(trendPath(gameId, `${RANGE}&granularity=week`));
    expect(response.status).toBe(403);
  });

  it('rejects the trend without a session', async () => {
    const response = await testApp.app.request(trendPath(gameId, `${RANGE}&granularity=week`));
    expect(response.status).toBe(401);
  });
});
