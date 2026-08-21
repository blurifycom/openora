import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import { TagService } from '../service/tag.service.js';

let db: TestDb;
let svc: TagService;

async function tagIdFor(key: TagKey) {
  const [existing] = await db.drizzle.db.select().from(tag).where(eq(tag.key, key));
  if (existing) {
    return existing.id;
  }
  const [created] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return created!.id;
}

async function seedPlayerWithTags(activeKeys: TagKey[], removedKeys: TagKey[] = []) {
  const userId = randomUUID();
  const [playerRow] = await db.drizzle.db.insert(player).values({ userId }).returning();
  for (const key of [...activeKeys, ...removedKeys]) {
    await db.drizzle.db.insert(playerTag).values({
      playerId: playerRow!.id,
      tagId: await tagIdFor(key),
      assignReason: 'seed',
      assignActor: 'manual',
      assignActorUserId: randomUUID(),
      removedAt: removedKeys.includes(key) ? new Date() : null,
    });
  }
  return userId;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
  svc = new TagService(db.drizzle, makeEventBus());
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('TagService.getActiveTagKeys (real PG)', () => {
  it('groups active tag keys per user, keyed by auth userId', async () => {
    const tagged = await seedPlayerWithTags(['high_risk', 'bonus_abuser']);
    const vip = await seedPlayerWithTags(['vip']);
    const untagged = randomUUID();

    const map = await svc.getActiveTagKeys([tagged, vip, untagged]);

    expect(map.get(tagged)?.sort()).toEqual(['bonus_abuser', 'high_risk']);
    expect(map.get(vip)).toEqual(['vip']);
    expect(map.has(untagged)).toBe(false);
  });

  it('excludes assignments that were removed', async () => {
    const userId = await seedPlayerWithTags(['vip'], ['high_risk']);

    const map = await svc.getActiveTagKeys([userId]);

    expect(map.get(userId)).toEqual(['vip']);
  });

  it('omits a user whose every tag was removed', async () => {
    const userId = await seedPlayerWithTags([], ['high_risk']);

    const map = await svc.getActiveTagKeys([userId]);

    expect(map.has(userId)).toBe(false);
  });

  it('ignores users outside the requested set', async () => {
    const wanted = await seedPlayerWithTags(['vip']);
    const other = await seedPlayerWithTags(['high_risk']);

    const map = await svc.getActiveTagKeys([wanted]);

    expect(map.has(other)).toBe(false);
  });

  it('returns an empty map for an empty input', async () => {
    await seedPlayerWithTags(['vip']);

    expect((await svc.getActiveTagKeys([])).size).toBe(0);
  });
});
