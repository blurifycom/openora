import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { MAX_PLAYER_SEGMENT_TAGS, type PlayerStatus, type TagKey } from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
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

async function assignTag(playerId: string, key: TagKey, { removed = false } = {}) {
  await db.drizzle.db.insert(playerTag).values({
    playerId,
    tagId: await tagIdFor(key),
    assignReason: 'seed',
    assignActor: 'manual',
    assignActorUserId: randomUUID(),
    removedAt: removed ? new Date() : null,
  });
}

async function seedPlayer({
  status = 'active',
  deactivated = false,
  tags = [],
  removedTags = [],
}: {
  status?: PlayerStatus;
  deactivated?: boolean;
  tags?: TagKey[];
  removedTags?: TagKey[];
} = {}) {
  const seeded = await seedPlayerWithUser(db, { status });
  if (deactivated) {
    await db.drizzle.db.update(user).set({ isActive: false }).where(eq(user.id, seeded.account.id));
  }
  for (const key of [...tags, ...removedTags]) {
    await assignTag(seeded.player.id, key, { removed: removedTags.includes(key) });
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

  it('keeps suspended, self-excluded and dormant players and leaves out closed, deactivated and staff ones', async () => {
    const kept = await Promise.all(
      (['active', 'dormant', 'suspended', 'self_excluded'] as const).map(
        async (status) => (await seedPlayer({ status })).playerId,
      ),
    );
    await seedPlayer({ status: 'closed' });
    await seedPlayer({ deactivated: true });
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

  it('refuses an empty tag list rather than reading it as every player', async () => {
    await seedPlayer();

    await expect(reader.page({ tags: [], limit: 10 })).rejects.toThrow(
      new RangeError('tags must name at least one tag'),
    );
  });

  it('refuses a tag key that is not a tag before it reaches the database', async () => {
    const tags = mock<TagKey[]>(['vip', 'whale']);

    await expect(reader.page({ tags, limit: 10 })).rejects.toThrow(
      new RangeError('tags must hold only tag keys'),
    );
  });
});

describe('PlayerSegmentReaderService.resolve (real PG)', () => {
  it('maps user ids to the player ids of players in the population', async () => {
    const active = await seedPlayer();
    const suspended = await seedPlayer({ status: 'suspended' });
    const closed = await seedPlayer({ status: 'closed' });
    const deactivated = await seedPlayer({ deactivated: true });
    const staff = await seedStaffWithProfile();

    const resolved = await reader.resolve({
      userIds: [
        active.userId,
        suspended.userId,
        closed.userId,
        deactivated.userId,
        staff.userId,
        randomUUID(),
        'x',
      ],
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

describe('PlayerSegmentReaderService.describe (real PG)', () => {
  it('counts the population holding each tag, leaving out deactivated, closed, staff and removed holders', async () => {
    await seedPlayer({ tags: ['vip'] });
    await seedPlayer({ status: 'suspended', tags: ['vip', 'high_roller'] });
    await seedPlayer({ deactivated: true, tags: ['vip', 'high_roller'] });
    await seedPlayer({ status: 'closed', tags: ['vip'] });
    await seedPlayer({ removedTags: ['vip'] });
    const staff = await seedStaffWithProfile();
    await assignTag(staff.playerId, 'vip');

    expect(await reader.describe(['vip', 'high_roller'])).toEqual([
      { tag: 'vip', name: 'vip', playerCount: 2 },
      { tag: 'high_roller', name: 'high_roller', playerCount: 1 },
    ]);
  });

  it('answers each tag once, in the order asked', async () => {
    await seedPlayer({ tags: ['vip', 'inactive', 'high_roller'] });

    const described = await reader.describe(['inactive', 'vip', 'inactive', 'high_roller']);

    expect(described.map((entry) => entry.tag)).toEqual(['inactive', 'vip', 'high_roller']);
  });

  it('counts zero for a tag no player of the population holds and for a tag key with no tag row', async () => {
    await seedPlayer({ deactivated: true, tags: ['inactive'] });
    await seedPlayer({ removedTags: ['vip'] });

    expect(await reader.describe(['inactive', 'vip', 'kyc_pending'])).toEqual([
      { tag: 'inactive', name: 'inactive', playerCount: 0 },
      { tag: 'vip', name: 'vip', playerCount: 0 },
      { tag: 'kyc_pending', name: 'kyc_pending', playerCount: 0 },
    ]);
  });

  it('refuses an empty tag list', async () => {
    await expect(reader.describe([])).rejects.toThrow(
      new RangeError('tags must name at least one tag'),
    );
  });

  it('refuses a key that is not a tag key', async () => {
    await expect(reader.describe(['vip', 'whale'])).rejects.toThrow(
      new RangeError('tags must hold only tag keys'),
    );
  });

  it(`takes up to ${MAX_PLAYER_SEGMENT_TAGS} entries and refuses more`, async () => {
    const tooMany = Array.from({ length: MAX_PLAYER_SEGMENT_TAGS + 1 }, () => 'vip');

    expect(await reader.describe(tooMany.slice(1))).toEqual([
      { tag: 'vip', name: 'vip', playerCount: 0 },
    ]);
    await expect(reader.describe(tooMany)).rejects.toThrow(
      new RangeError(`describe takes at most ${MAX_PLAYER_SEGMENT_TAGS} tags`),
    );
  });
});
