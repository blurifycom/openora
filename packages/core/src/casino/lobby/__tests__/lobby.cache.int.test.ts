import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
} from '@openora/core/casino/schema/gaming';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { featuredSlot } from '../schema/index.js';
import { LobbyService } from '../service/lobby.service.js';

let db: TestDb;
let redis: TestRedis;

beforeAll(async () => {
  db = await createTestDb([migrateGaming, migrateLobby]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${featuredSlot}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('LobbyService featured cache (real PG + real Redis)', () => {
  it('serves the second read from cache under a 30s TTL, ignoring later DB writes', async () => {
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme-studio', name: 'Acme Studio' })
      .returning();
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: 'slots', name: 'Slots' })
      .returning();
    const [g] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Aces',
        slug: 'aces',
        providerId: provider!.id,
        aggregator: 'direct',
        thumbnailUrl: 'aces.png',
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: g!.id, categoryId: category!.id });
    const [slot] = await db.drizzle.db
      .insert(featuredSlot)
      .values({ gameId: g.id, title: 'Big Win', placement: 'home', sortOrder: 0, isActive: true })
      .returning();

    const svc = new LobbyService(db.drizzle, new RedisCache(redis.client));

    const first = await svc.getFeatured();
    expect(first).toEqual([
      {
        id: slot.id,
        title: 'Big Win',
        gameId: g.id,
        gameName: 'Aces',
        thumbnailUrl: 'aces.png',
        placement: 'home',
        sortOrder: 0,
      },
    ]);

    const pttl = await redis.client.pTTL('cache:lobby:featured');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);

    // TTL-only cache (no invalidation): a direct DB write stays invisible until the TTL lapses.
    await db.drizzle.db.update(game).set({ name: 'Renamed' }).where(eq(game.id, g.id));
    const second = await svc.getFeatured();
    expect(second).toEqual(first);
  });
});
