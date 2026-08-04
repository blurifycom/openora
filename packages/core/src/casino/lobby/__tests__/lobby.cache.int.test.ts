import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { game } from '@openora/core/casino/schema/gaming';
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
  await db.drizzle.db.execute(sql`TRUNCATE ${featuredSlot}, ${game} RESTART IDENTITY CASCADE`);
  await redis.flush();
});

describe('LobbyService featured cache (real PG + real Redis)', () => {
  it('serves the second read from cache under a 30s TTL, ignoring later DB writes', async () => {
    const [g] = await db.drizzle.db
      .insert(game)
      .values({ name: 'Aces', provider: 'acme', category: 'slots', thumbnailUrl: 'aces.png' })
      .returning();
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
