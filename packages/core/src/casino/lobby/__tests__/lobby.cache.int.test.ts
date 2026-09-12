import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createLobbySectionCatalog } from '@openora/core/contracts';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { makeEventBus } from '../../../testing/mock.js';
import { lobbyLayout, lobbySection } from '../schema/index.js';
import { LobbyService } from '../service/lobby.service.js';

const configSchema = z.object({ value: z.string() });

let db: TestDb;
let redis: TestRedis;

beforeAll(async () => {
  db = await createTestDb([migrateLobby]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${lobbySection}, ${lobbyLayout} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('LobbyService layout cache', () => {
  it('invalidates the public layout cache when the aggregate is replaced', async () => {
    const catalog = createLobbySectionCatalog([
      {
        type: 'text',
        parseConfig: (config) => configSchema.parse(config),
        async resolve(sections) {
          return new Map(sections.map((section) => [section.id, section.config]));
        },
      },
    ]);
    const svc = new LobbyService(db.drizzle, makeEventBus(), catalog, new RedisCache(redis.client));
    await svc.replaceLayout({
      version: 0,
      sections: [{ type: 'text', config: { value: 'first' }, isEnabled: true }],
      ip: null,
      userAgent: null,
    });
    const first = await svc.getLayout();
    expect(first).toMatchObject([{ type: 'text', data: { value: 'first' } }]);
    expect(await redis.client.pTTL('cache:lobby:layout')).toBeGreaterThan(0);

    const admin = await svc.getAdminLayout();
    await svc.replaceLayout({
      version: admin.version,
      sections: [{ type: 'text', config: { value: 'second' }, isEnabled: true }],
      ip: null,
      userAgent: null,
    });
    expect(await svc.getLayout()).toMatchObject([{ type: 'text', data: { value: 'second' } }]);
  });
});
