import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { DrizzleService } from '../drizzle.service.js';

const marker = pgTable('replica_marker', { value: text().notNull() });

const opened: TestDb[] = [];
const envKeys = ['DATABASE_URL', 'DATABASE_REPLICA_URLS'] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of envKeys) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
  for (const testDb of opened.splice(0)) {
    await testDb.drop();
  }
});

async function markedDb(value: string) {
  const testDb = await createTestDb([]);
  opened.push(testDb);
  await testDb.drizzle.db.execute(sql`CREATE TABLE replica_marker (value text NOT NULL)`);
  await testDb.drizzle.db.insert(marker).values({ value });
  return testDb;
}

const markers = async (testDb: TestDb) =>
  (await testDb.drizzle.db.select().from(marker)).map((row) => row.value).sort();

const currentDatabase = async (handle: DrizzleService['replica']) => {
  const [row] = await handle.select({ name: sql<string>`current_database()` }).from(marker);
  return row?.name;
};

describe('replicas', () => {
  it('selects go to a configured replica and writes go to the primary', async () => {
    const primary = await markedDb('primary');
    const replica = await markedDb('replica');
    process.env['DATABASE_URL'] = primary.url;
    process.env['DATABASE_REPLICA_URLS'] = replica.url;
    const service = new DrizzleService();
    try {
      expect(await service.replica.select().from(marker)).toEqual([{ value: 'replica' }]);
      expect(await service.db.select().from(marker)).toEqual([{ value: 'primary' }]);
      await service.replica.insert(marker).values({ value: 'written-through-replica-handle' });
      expect(await markers(primary)).toEqual(['primary', 'written-through-replica-handle']);
      expect(await markers(replica)).toEqual(['replica']);
    } finally {
      await service.dispose();
    }
  });

  it('without replica urls the replica handle is the primary', async () => {
    const primary = await markedDb('primary');
    process.env['DATABASE_URL'] = primary.url;
    process.env['DATABASE_REPLICA_URLS'] = ' , ';
    const service = new DrizzleService();
    try {
      expect(service.replica).toBe(service.db);
      expect(await service.replica.select().from(marker)).toEqual([{ value: 'primary' }]);
    } finally {
      await service.dispose();
    }
  });

  it('an explicit url opens that database alone without replicas', async () => {
    const configured = await markedDb('configured primary');
    const replica = await markedDb('replica');
    const explicit = await markedDb('explicit');
    process.env['DATABASE_URL'] = configured.url;
    process.env['DATABASE_REPLICA_URLS'] = replica.url;
    const service = new DrizzleService(explicit.url);
    try {
      expect(service.replica).toBe(service.db);
      expect(await service.replica.select().from(marker)).toEqual([{ value: 'explicit' }]);
      expect(await currentDatabase(service.replica)).toBe(new URL(explicit.url).pathname.slice(1));
    } finally {
      await service.dispose();
    }
  });

  it.todo('an invalid pool size env falls back to the default');
});
