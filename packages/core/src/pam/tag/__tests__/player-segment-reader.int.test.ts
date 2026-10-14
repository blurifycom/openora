import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PlayerStatus, TagKey } from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import { PlayerSegmentReaderService } from '../adapters/player-segment-reader.service.js';

let db: TestDb;
let reader: PlayerSegmentReaderService;

async function tagIdFor(key: TagKey) {
  const [existing] = await db.drizzle.db.select().from(tag).where(eq(tag.key, key));
  if (existing) {
    return existing.id;
  }
  const [created] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return created!.id;
}

async function seedPlayer({
  status = 'active',
  tags = [],
  removedTags = [],
}: { status?: PlayerStatus; tags?: TagKey[]; removedTags?: TagKey[] } = {}) {
  const seeded = await seedPlayerWithUser(db, { status });
  for (const key of [...tags, ...removedTags]) {
    await db.drizzle.db.insert(playerTag).values({
      playerId: seeded.player.id,
      tagId: await tagIdFor(key),
      assignReason: 'seed',
      assignActor: 'manual',
      assignActorUserId: randomUUID(),
      removedAt: removedTags.includes(key) ? new Date() : null,
    });
  }
  return { playerId: seeded.player.id, userId: seeded.account.id };
}

/** A staff login that also carries a player profile. */
async function seedStaffWithProfile() {
  const account = await seedUser(db, { role: 'admin' });
  const [row] = await db.drizzle.db.insert(player).values({ userId: account.id }).returning();
  return { playerId: row!.id, userId: account.id };
}

const ascending = (ids: string[]) => [...ids].sort();

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrate]);
  reader = new PlayerSegmentReaderService(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('PlayerSegmentReaderService.page (real PG)', () => {
  it('walks every player once, in ascending id order, and ends with next null', async () => {
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push((await seedPlayer()).playerId);
    }

    const first = await reader.page({ limit: 2 });
    const second = await reader.page({ limit: 2, after: first.next! });
    const third = await reader.page({ limit: 2, after: second.next! });

    expect([...first.playerIds, ...second.playerIds, ...third.playerIds]).toEqual(
      ascending(seeded),
    );
    expect(first.next).toBe(first.playerIds[1]);
    expect(third).toEqual({ playerIds: [expect.any(String)], next: null });
  });

  it('returns next null when the last page is exactly full', async () => {
    await seedPlayer();
    await seedPlayer();

    expect(await reader.page({ limit: 2 })).toEqual({
      playerIds: expect.any(Array),
      next: null,
    });
  });

  it('keeps suspended, self-excluded and dormant players and leaves out closed ones and staff', async () => {
    const kept = await Promise.all(
      (['active', 'dormant', 'suspended', 'self_excluded'] as const).map(
        async (status) => (await seedPlayer({ status })).playerId,
      ),
    );
    await seedPlayer({ status: 'closed' });
    await seedStaffWithProfile();

    expect((await reader.page({ limit: 100 })).playerIds).toEqual(ascending(kept));
  });

  it('with tags, returns players holding any of them, ignoring removed tags', async () => {
    const vip = await seedPlayer({ tags: ['vip'] });
    const highRoller = await seedPlayer({ tags: ['high_roller', 'inactive'] });
    await seedPlayer({ tags: ['inactive'] });
    await seedPlayer({ removedTags: ['vip'] });
    await seedPlayer();

    const page = await reader.page({ tags: ['vip', 'high_roller', 'vip'], limit: 100 });

    expect(page.playerIds).toEqual(ascending([vip.playerId, highRoller.playerId]));
  });

  it.each([
    ['a zero limit', { limit: 0 }],
    ['a limit over 1000', { limit: 1001 }],
    ['a fractional limit', { limit: 1.5 }],
    ['an after that is not a player id', { limit: 10, after: 'next' }],
  ])('refuses %s', async (_case, query) => {
    await expect(reader.page(query)).rejects.toThrow(RangeError);
  });
});

describe('PlayerSegmentReaderService.resolve (real PG)', () => {
  it('maps user ids to the player ids of players in the population', async () => {
    const active = await seedPlayer();
    const suspended = await seedPlayer({ status: 'suspended' });
    const closed = await seedPlayer({ status: 'closed' });
    const staff = await seedStaffWithProfile();

    const resolved = await reader.resolve({
      userIds: [active.userId, suspended.userId, closed.userId, staff.userId, randomUUID(), 'x'],
    });

    expect(resolved).toEqual(
      new Map([
        [active.userId, active.playerId],
        [suspended.userId, suspended.playerId],
      ]),
    );
  });

  it('keeps the given player ids that are in the population', async () => {
    const active = await seedPlayer();
    const closed = await seedPlayer({ status: 'closed' });
    const staff = await seedStaffWithProfile();

    const resolved = await reader.resolve({
      playerIds: [active.playerId, active.playerId, closed.playerId, staff.playerId],
    });

    expect(resolved).toEqual(new Map([[active.playerId, active.playerId]]));
  });

  it('answers an empty map without a query for no usable id, and refuses more than 1000', async () => {
    expect(await reader.resolve({ userIds: ['not-a-uuid'] })).toEqual(new Map());
    await expect(
      reader.resolve({ playerIds: Array.from({ length: 1001 }, () => randomUUID()) }),
    ).rejects.toThrow(RangeError);
  });
});
