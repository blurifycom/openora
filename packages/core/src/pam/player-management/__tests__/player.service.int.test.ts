import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  TagKey,
  AdminUserDirectory,
  AdminGameReporting,
  ChatBlockWriter,
  SessionCommands,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { tag, playerTag } from '@openora/core/pam/schema/tag';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { mock, makeEventBus } from '../../../testing/mock.js';
import {
  PlayerService,
  PlayerNotFoundError,
  DuplicateUsernameError,
} from '../service/player.service.js';

let db: TestDb;

function makeService(
  overrides: {
    userDirectory?: AdminUserDirectory;
    gameReporting?: AdminGameReporting;
    blockWriter?: ChatBlockWriter;
    sessionCommands?: SessionCommands;
  } = {},
) {
  const events = makeEventBus();
  const userDirectory = overrides.userDirectory ?? mock<AdminUserDirectory>({});
  const gameReporting = overrides.gameReporting ?? mock<AdminGameReporting>({});
  const blockWriter = overrides.blockWriter ?? mock<ChatBlockWriter>({});
  const sessionCommands =
    overrides.sessionCommands ??
    mock<SessionCommands>({ revokeAll: vi.fn().mockResolvedValue({ success: true }) });
  return {
    svc: new PlayerService(
      db.drizzle,
      events,
      userDirectory,
      gameReporting,
      blockWriter,
      sessionCommands,
    ),
    events,
    sessionCommands,
  };
}

const SEARCH_VIEWER_ID = '00000000-0000-0000-0000-0000000000a1';
const SEARCH_OTHER_ID = '00000000-0000-0000-0000-0000000000a2';
const SEARCH_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

const SEARCH_VIEWER_PLAYER_ID = '00000000-0000-0000-0000-0000000000b1';
const SEARCH_OTHER_PLAYER_ID = '00000000-0000-0000-0000-0000000000b2';

function makeUserDirectory(): AdminUserDirectory {
  const all = [
    {
      playerId: SEARCH_VIEWER_PLAYER_ID,
      userId: SEARCH_VIEWER_ID,
      username: 'bob',
      email: 'bob@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: SEARCH_CREATED_AT,
      level: 3,
      currency: 'USD',
    },
    {
      playerId: SEARCH_OTHER_PLAYER_ID,
      userId: SEARCH_OTHER_ID,
      username: 'alice',
      email: 'alice@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: SEARCH_CREATED_AT,
      level: 1,
      currency: 'USD',
    },
  ];
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([SEARCH_VIEWER_ID]),
    lookupPlayers: vi.fn().mockImplementation((ids: string[]) => {
      return Promise.resolve(all.filter((p) => ids.includes(p.userId)));
    }),
  });
}

function makeGameReporting(): AdminGameReporting {
  return mock<AdminGameReporting>({
    getPlayerStats: vi.fn().mockResolvedValue({ totalWagered: '100.00000000', totalBets: 5 }),
  });
}

function makeBlockWriter(excluded: string[] = []): ChatBlockWriter {
  return mock<ChatBlockWriter>({
    getExcludedUserIds: vi.fn().mockResolvedValue(excluded),
  });
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      username: randomUUID().replaceAll('-', '').slice(0, 20),
      email: `${randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function seedPlayerWithUser(
  userOverrides: Partial<typeof user.$inferInsert> = {},
  playerOverrides: Partial<typeof player.$inferInsert> = {},
) {
  const account = await seedUser(userOverrides);
  const row = await seedPlayer(account.id, playerOverrides);
  return { account, player: row };
}

async function seedTag(key: TagKey) {
  const [row] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return row!;
}

async function assignTag(playerId: string, tagId: string) {
  await db.drizzle.db.insert(playerTag).values({
    playerId,
    tagId,
    assignReason: 'test',
    assignActor: 'manual',
    assignActorUserId: null,
  });
}

async function rowById(playerId: string) {
  const [row] = await db.drizzle.db.select().from(player).where(eq(player.id, playerId));
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateTag]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

const ACTOR_ID = '00000000-0000-0000-0000-0000000000ff';

describe('PlayerService.remove (real PG)', () => {
  it('soft-deletes by closing the player, never deletes the row', async () => {
    const { svc } = makeService();
    const { player: seeded } = await seedPlayerWithUser();

    const result = await svc.remove(seeded.id, ACTOR_ID);

    expect(result).toEqual({ success: true });
    expect(await rowById(seeded.id)).toMatchObject({ status: 'closed' });
  });

  it('revokes every session for the removed player, passing the userId and the actor id', async () => {
    const { svc, sessionCommands } = makeService();
    const { account, player: seeded } = await seedPlayerWithUser();

    await svc.remove(seeded.id, ACTOR_ID);

    expect(sessionCommands.revokeAll).toHaveBeenCalledWith(account.id, ACTOR_ID);
  });

  it('throws PlayerNotFoundError when the player does not exist', async () => {
    const { svc } = makeService();

    await expect(svc.remove(randomUUID(), ACTOR_ID)).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.touchLastSeen (real PG)', () => {
  it('writes lastSeenAt when it was previously null', async () => {
    const { svc } = makeService();
    const seeded = await seedPlayer(randomUUID());

    await svc.touchLastSeen(seeded.userId);

    const row = await rowById(seeded.id);
    expect(row?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('writes lastSeenAt when it is stale (older than 1 minute)', async () => {
    const { svc } = makeService();
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000);
    const seeded = await seedPlayer(randomUUID(), { lastSeenAt: staleTimestamp });

    await svc.touchLastSeen(seeded.userId);

    const row = await rowById(seeded.id);
    expect(row?.lastSeenAt?.getTime()).toBeGreaterThan(staleTimestamp.getTime());
  });

  it('skips the write (throttle) when lastSeenAt is recent', async () => {
    const { svc } = makeService();
    const recentTimestamp = new Date();
    const seeded = await seedPlayer(randomUUID(), { lastSeenAt: recentTimestamp });

    await svc.touchLastSeen(seeded.userId);

    const row = await rowById(seeded.id);
    expect(row?.lastSeenAt?.getTime()).toBe(recentTimestamp.getTime());
  });

  it('is a no-op for a nonexistent userId (never throws)', async () => {
    const { svc } = makeService();

    await expect(svc.touchLastSeen(randomUUID())).resolves.toBeUndefined();
  });
});

describe('PlayerService.getByUserId (real PG)', () => {
  it('returns the player enriched with the identity email', async () => {
    const { svc } = makeService();
    const { account, player: seeded } = await seedPlayerWithUser({ email: 'jordan@example.com' });

    const result = await svc.getByUserId(account.id);

    expect(result).toMatchObject({
      id: seeded.id,
      userId: account.id,
      email: 'jordan@example.com',
    });
  });

  it('throws PlayerNotFoundError when no player owns the userId', async () => {
    const { svc } = makeService();

    await expect(svc.getByUserId(randomUUID())).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.registrationsOverTime (real PG)', () => {
  it('returns one zero-filled bucket per day in the window', async () => {
    const { svc } = makeService();

    const points = await svc.registrationsOverTime(7);

    expect(points).toHaveLength(7);
    expect(points.every((p) => p.count === 0)).toBe(true);
    const dates = points.map((p) => p.date);
    expect(new Set(dates).size).toBe(7);
    expect(dates).toEqual([...dates].sort());
  });

  it('places each days registrations into its matching bucket', async () => {
    const { svc } = makeService();
    const todayKey = new Date().toISOString().slice(0, 10);
    await seedPlayer(randomUUID(), { createdAt: new Date() });
    await seedPlayer(randomUUID(), { createdAt: new Date() });
    await seedPlayer(randomUUID(), { createdAt: new Date() });

    const points = await svc.registrationsOverTime(7);

    const today = points.find((p) => p.date === todayKey);
    expect(today?.count).toBe(3);
    expect(points.filter((p) => p.date !== todayKey).every((p) => p.count === 0)).toBe(true);
  });
});

describe('PlayerService.list (real PG)', () => {
  it('filters by status', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'suspended' });

    const { items, total } = await svc.list({ page: 1, limit: 20, status: 'suspended' });

    expect(total).toBe(1);
    expect(items[0]?.status).toBe('suspended');
  });

  it('matches players by a username substring', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({ username: 'alice_anderson' });
    await seedPlayerWithUser({ username: 'bob_baker' });

    const { items, total } = await svc.list({ page: 1, limit: 20, search: 'ander' });

    expect(total).toBe(1);
    expect(items[0]?.username).toBe('alice_anderson');
  });

  it('matches players by an email substring', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({ email: 'searchable-target@example.com' });
    await seedPlayerWithUser({ email: 'someone-else@example.com' });

    const { items, total } = await svc.list({ page: 1, limit: 20, search: 'searchable-target' });

    expect(total).toBe(1);
    expect(items[0]?.email).toBe('searchable-target@example.com');
  });

  it('restricts results to players carrying any of the given tags, excluding removed assignments', async () => {
    const { svc } = makeService();
    const vip = await seedTag('vip');
    const highRisk = await seedTag('high_risk');
    const { player: tagged } = await seedPlayerWithUser();
    const { player: removedTag } = await seedPlayerWithUser();
    const { player: untagged } = await seedPlayerWithUser();
    await assignTag(tagged.id, vip.id);
    await assignTag(removedTag.id, highRisk.id);
    await db.drizzle.db
      .update(playerTag)
      .set({ removedAt: new Date() })
      .where(eq(playerTag.playerId, removedTag.id));

    const { items, total } = await svc.list({ page: 1, limit: 20, tags: ['vip', 'high_risk'] });

    expect(total).toBe(1);
    expect(items.map((i) => i.id)).toEqual([tagged.id]);
    expect(items.map((i) => i.id)).not.toContain(untagged.id);
  });

  it('keeps the total across the whole filtered set, not just the returned page', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'suspended' });

    const { items, total } = await svc.list({ page: 2, limit: 2, status: 'active' });

    expect(total).toBe(3);
    expect(items).toHaveLength(1);
  });

  it('orders by the requested sort field and direction', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({ username: 'charlie' });
    await seedPlayerWithUser({ username: 'alice' });
    await seedPlayerWithUser({ username: 'bob' });

    const { items } = await svc.list({
      page: 1,
      limit: 20,
      sortBy: 'username',
      sortOrder: 'asc',
    });

    expect(items.map((i) => i.username)).toEqual(['alice', 'bob', 'charlie']);
  });
});

describe('PlayerService.get / getExtended (real PG)', () => {
  it('returns the player with its assigned tags', async () => {
    const { svc } = makeService();
    const vip = await seedTag('vip');
    const { player: seeded } = await seedPlayerWithUser();
    await assignTag(seeded.id, vip.id);

    const result = await svc.get(seeded.id);

    expect(result.tags).toEqual(['vip']);
  });

  it('throws PlayerNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.get(randomUUID())).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.update (real PG)', () => {
  it('persists simple field changes and returns the enriched row', async () => {
    const { svc } = makeService();
    const { player: seeded, account } = await seedPlayerWithUser();

    const result = await svc.update(seeded.id, { username: 'renamed', level: 5 }, account.id);

    expect(result).toMatchObject({ username: 'renamed', level: 5 });
    expect(await rowById(seeded.id)).toMatchObject({ level: 5 });
  });

  it('maps only the username unique constraint to DuplicateUsernameError', async () => {
    const { svc } = makeService();
    await seedUser({ username: 'taken_name' });
    const { player: seeded, account } = await seedPlayerWithUser();

    await expect(
      svc.update(seeded.id, { username: 'taken_name' }, account.id),
    ).rejects.toBeInstanceOf(DuplicateUsernameError);
  });

  it('throws PlayerNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(
      svc.update(randomUUID(), { username: 'player_x' }, randomUUID()),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.update session revocation on block (real PG)', () => {
  it('revokes every session when a player transitions active -> suspended, with the userId and actor id', async () => {
    const { svc, sessionCommands } = makeService();
    const { account, player: seeded } = await seedPlayerWithUser({}, { status: 'active' });

    await svc.update(seeded.id, { status: 'suspended' }, ACTOR_ID);

    expect(sessionCommands.revokeAll).toHaveBeenCalledTimes(1);
    expect(sessionCommands.revokeAll).toHaveBeenCalledWith(account.id, ACTOR_ID);
  });

  it('does not revoke sessions on a transition to a non-blocking status (dormant)', async () => {
    const { svc, sessionCommands } = makeService();
    const { player: seeded } = await seedPlayerWithUser({}, { status: 'active' });

    await svc.update(seeded.id, { status: 'dormant' }, ACTOR_ID);

    expect(sessionCommands.revokeAll).not.toHaveBeenCalled();
  });

  it('does not revoke sessions when the status is set to suspended but was already suspended (no transition)', async () => {
    const { svc, sessionCommands } = makeService();
    const { player: seeded } = await seedPlayerWithUser({}, { status: 'suspended' });

    await svc.update(seeded.id, { status: 'suspended' }, ACTOR_ID);

    expect(sessionCommands.revokeAll).not.toHaveBeenCalled();
  });
});

describe('PlayerService.update player.level.changed emission (real PG)', () => {
  it('emits player.level.changed with previousLevel/newLevel/actorId when level changes', async () => {
    const { svc, events } = makeService();
    const { player: seeded, account } = await seedPlayerWithUser({}, { level: 1 });

    await svc.update(seeded.id, { level: 5 }, account.id);

    expect(events.emit).toHaveBeenCalledWith('player.level.changed', {
      userId: account.id,
      playerId: seeded.id,
      previousLevel: 1,
      newLevel: 5,
      actorId: account.id,
    });
  });

  it('does not emit when level is omitted from the patch', async () => {
    const { svc, events } = makeService();
    const { player: seeded, account } = await seedPlayerWithUser({}, { level: 1 });

    await svc.update(seeded.id, { username: 'new_name' }, account.id);

    expect(events.emit).not.toHaveBeenCalledWith('player.level.changed', expect.anything());
  });

  it('does not emit when level is unchanged', async () => {
    const { svc, events } = makeService();
    const { player: seeded, account } = await seedPlayerWithUser({}, { level: 3 });

    await svc.update(seeded.id, { level: 3 }, account.id);

    expect(events.emit).not.toHaveBeenCalledWith('player.level.changed', expect.anything());
  });
});

// Ported from chat-commands.service.test.ts (ChatCommandsService.searchPlayers/
// getPlayerProfile) - these methods never touch the DB, only the injected ports.
describe('PlayerService.searchPlayers', () => {
  it('returns mapped player search results', async () => {
    const userDirectory = makeUserDirectory();
    const { svc } = makeService({ userDirectory, blockWriter: makeBlockWriter() });

    const result = await svc.searchPlayers('bo', 5, SEARCH_VIEWER_ID);

    expect(userDirectory.findPlayerIds).toHaveBeenCalledWith('bo', 5);
    expect(result).toEqual([
      { userId: SEARCH_VIEWER_ID, username: 'bob', avatarUrl: null, level: 3 },
    ]);
  });

  it('returns empty array when no matches', async () => {
    const userDirectory = mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const { svc } = makeService({ userDirectory });

    const result = await svc.searchPlayers('xyz', 10, SEARCH_VIEWER_ID);

    expect(result).toEqual([]);
  });

  it('excludes ids the viewer has blocked or ignored', async () => {
    const userDirectory = makeUserDirectory();
    const blockWriter = makeBlockWriter([SEARCH_VIEWER_ID]);
    const { svc } = makeService({ userDirectory, blockWriter });

    const result = await svc.searchPlayers('bo', 5, SEARCH_OTHER_ID);

    expect(blockWriter.getExcludedUserIds).toHaveBeenCalledWith(SEARCH_OTHER_ID);
    expect(result).toEqual([]);
  });
});

describe('PlayerService.getPlayerProfile', () => {
  it('returns the full profile card on the happy path (self view)', async () => {
    const gameReporting = makeGameReporting();
    const { svc } = makeService({ userDirectory: makeUserDirectory(), gameReporting });

    const result = await svc.getPlayerProfile(SEARCH_VIEWER_ID, SEARCH_VIEWER_ID);

    expect(gameReporting.getPlayerStats).toHaveBeenCalledWith(SEARCH_VIEWER_ID);
    expect(result).toEqual({
      userId: SEARCH_VIEWER_ID,
      username: 'bob',
      avatarUrl: null,
      level: 3,
      joinedAt: SEARCH_CREATED_AT.toISOString(),
      totalWagered: '100.00000000',
      totalBets: 5,
      currency: 'USD',
    });
  });

  it('throws PlayerNotFoundError for an unknown userId', async () => {
    const userDirectory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const { svc } = makeService({ userDirectory });

    await expect(svc.getPlayerProfile(SEARCH_OTHER_ID, SEARCH_VIEWER_ID)).rejects.toBeInstanceOf(
      PlayerNotFoundError,
    );
  });

  it('redacts private profile fields for another viewer', async () => {
    const gameReporting = makeGameReporting();
    const { svc } = makeService({ userDirectory: makeUserDirectory(), gameReporting });

    const result = await svc.getPlayerProfile(SEARCH_VIEWER_ID, SEARCH_OTHER_ID);

    expect(result).toMatchObject({
      userId: SEARCH_VIEWER_ID,
      username: 'bob',
      avatarUrl: null,
      level: 3,
      joinedAt: null,
      totalWagered: null,
      totalBets: null,
      currency: null,
    });
    expect(gameReporting.getPlayerStats).not.toHaveBeenCalled();
  });
});
