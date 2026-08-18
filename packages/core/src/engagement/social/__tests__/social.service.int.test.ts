import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { IdentityReader } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatUserBlock, chatUserIgnore } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { friendship } from '../schema/index.js';
import {
  SocialService,
  SelfFriendRequestError,
  FriendRequestTargetNotFoundError,
  FriendRequestUnavailableError,
  AlreadyFriendsError,
  RequestAlreadyPendingError,
  FriendRequestRefusedError,
  BlockedBySelfError,
  FriendshipNotFoundError,
  FriendRequestNotFoundError,
} from '../service/social.service.js';

let db: TestDb;

function realIdentityReader(): IdentityReader {
  return {
    ...makeIdentityReader(),
    getPlayerIdByUserIdSafe: async (userId) => {
      const [row] = await db.drizzle.db
        .select({ id: player.id })
        .from(player)
        .where(eq(player.userId, userId));
      return row?.id ?? null;
    },
  };
}

function makeService() {
  const events = makeEventBus();
  return { svc: new SocialService(db.drizzle, events, realIdentityReader()), events };
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function seedBlock(blockerId: string, blockedId: string) {
  await db.drizzle.db.insert(chatUserBlock).values({ blockerId, blockedId });
}

async function seedIgnore(ignorerId: string, ignoredId: string) {
  await db.drizzle.db.insert(chatUserIgnore).values({ ignorerId, ignoredId });
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateChat]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${friendship}, ${chatUserBlock}, ${chatUserIgnore}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('SocialService.sendFriendRequest (real PG)', () => {
  it('inserts a pending row and emits social.friend_request.sent', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer({ displayName: 'Alice' });
    const addressee = await seedPlayer({ displayName: 'Bob' });

    const result = await svc.sendFriendRequest(requester.userId, addressee.userId);

    expect(result).toMatchObject({
      requesterId: requester.userId,
      addresseeId: addressee.userId,
      acceptedAt: null,
      refusedAt: null,
    });
    expect(typeof result.createdAt).toBe('string');
    expect(await db.drizzle.db.select().from(friendship)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith('social.friend_request.sent', {
      friendshipId: result.id,
      requesterId: requester.userId,
      addresseeId: addressee.userId,
      requesterDisplayName: 'Alice',
    });
  });

  it('throws SelfFriendRequestError when targeting self and does not emit', async () => {
    const { svc, events } = makeService();
    const p = await seedPlayer();

    await expect(svc.sendFriendRequest(p.userId, p.userId)).rejects.toBeInstanceOf(
      SelfFriendRequestError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws FriendRequestTargetNotFoundError when the target does not exist', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();

    await expect(svc.sendFriendRequest(requester.userId, randomUUID())).rejects.toBeInstanceOf(
      FriendRequestTargetNotFoundError,
    );
  });

  it.each(['suspended', 'closed'] as const)(
    'throws FriendRequestUnavailableError when the target is %s',
    async (status) => {
      const { svc } = makeService();
      const requester = await seedPlayer();
      const target = await seedPlayer({ status });

      await expect(svc.sendFriendRequest(requester.userId, target.userId)).rejects.toBeInstanceOf(
        FriendRequestUnavailableError,
      );
    },
  );

  it('throws FriendRequestUnavailableError (never leaking the block, same as suspended) when the target has blocked the caller', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const target = await seedPlayer();
    await seedBlock(target.userId, requester.userId);

    await expect(svc.sendFriendRequest(requester.userId, target.userId)).rejects.toBeInstanceOf(
      FriendRequestUnavailableError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws BlockedBySelfError when the caller has blocked the target', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const target = await seedPlayer();
    await seedBlock(requester.userId, target.userId);

    await expect(svc.sendFriendRequest(requester.userId, target.userId)).rejects.toBeInstanceOf(
      BlockedBySelfError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws RequestAlreadyPendingError on a same-direction duplicate and does not double-insert or re-emit', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const target = await seedPlayer();
    await svc.sendFriendRequest(requester.userId, target.userId);
    events.emit.mockClear();

    await expect(svc.sendFriendRequest(requester.userId, target.userId)).rejects.toBeInstanceOf(
      RequestAlreadyPendingError,
    );
    expect(events.emit).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(friendship)).toHaveLength(1);
  });

  it('throws AlreadyFriendsError once the pair is already friends', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const target = await seedPlayer();
    await svc.sendFriendRequest(requester.userId, target.userId);
    await svc.sendFriendRequest(target.userId, requester.userId); // mutual auto-accept
    events.emit.mockClear();

    await expect(svc.sendFriendRequest(requester.userId, target.userId)).rejects.toBeInstanceOf(
      AlreadyFriendsError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('auto-accepts a mutual/simultaneous request, updates the SAME row, and emits social.friend_request.accepted', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer({ displayName: 'Alice' });
    const bob = await seedPlayer({ displayName: 'Bob' });
    const first = await svc.sendFriendRequest(alice.userId, bob.userId);
    events.emit.mockClear();

    const result = await svc.sendFriendRequest(bob.userId, alice.userId);

    expect(result).toMatchObject({
      id: first.id,
      requesterId: alice.userId,
      addresseeId: bob.userId,
      refusedAt: null,
    });
    expect(result.acceptedAt).toEqual(expect.any(String));
    expect(events.emit).toHaveBeenCalledWith('social.friend_request.accepted', {
      friendshipId: first.id,
      requesterId: alice.userId,
      addresseeId: bob.userId,
      accepterId: bob.userId,
      accepterDisplayName: 'Bob',
    });
    const rows = await db.drizzle.db.select().from(friendship);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acceptedAt).toBeInstanceOf(Date);
    expect(rows[0]?.refusedAt).toBeNull();
  });

  it('keeps a refused request refused and does not auto-accept a new request for the pair', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const [refused] = await db.drizzle.db
      .insert(friendship)
      .values({
        requesterId: requester.userId,
        addresseeId: addressee.userId,
        refusedAt: new Date(),
      })
      .returning();

    const relationship = await svc.getRelationships(requester.userId, [addressee.userId]);

    expect(relationship).toEqual([
      {
        userId: addressee.userId,
        status: 'refused',
        friendshipId: refused?.id,
        canSendRequest: false,
      },
    ]);
    await expect(svc.sendFriendRequest(requester.userId, addressee.userId)).rejects.toBeInstanceOf(
      FriendRequestRefusedError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('SocialService.getRelationships (real PG)', () => {
  it('returns none + canSendRequest true for an unrelated active player', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const other = await seedPlayer();

    const result = await svc.getRelationships(caller.userId, [other.userId]);

    expect(result).toEqual([
      { userId: other.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);
  });

  it('returns none + canSendRequest true for both sides after a decline (regression: previously stuck on refused/canSendRequest:false forever)', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    await svc.declineFriendRequest(addressee.userId, request.id);

    const fromRequester = await svc.getRelationships(requester.userId, [addressee.userId]);
    const fromAddressee = await svc.getRelationships(addressee.userId, [requester.userId]);

    expect(fromRequester).toEqual([
      { userId: addressee.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);
    expect(fromAddressee).toEqual([
      { userId: requester.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);
  });

  it('returns unavailable for a nonexistent user', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();

    const result = await svc.getRelationships(caller.userId, [randomUUID()]);

    expect(result[0]).toMatchObject({ status: 'unavailable', canSendRequest: false });
  });

  it.each(['suspended', 'closed'] as const)(
    'returns unavailable for a %s target',
    async (status) => {
      const { svc } = makeService();
      const caller = await seedPlayer();
      const target = await seedPlayer({ status });

      const result = await svc.getRelationships(caller.userId, [target.userId]);

      expect(result[0]).toMatchObject({ status: 'unavailable', canSendRequest: false });
    },
  );

  it('returns unavailable when the target has blocked the caller', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const target = await seedPlayer();
    await seedBlock(target.userId, caller.userId);

    const result = await svc.getRelationships(caller.userId, [target.userId]);

    expect(result[0]).toMatchObject({ status: 'unavailable', canSendRequest: false });
  });

  it('returns blocked_by_me when the caller has blocked the target', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const target = await seedPlayer();
    await seedBlock(caller.userId, target.userId);

    const result = await svc.getRelationships(caller.userId, [target.userId]);

    expect(result[0]).toMatchObject({
      status: 'blocked_by_me',
      friendshipId: null,
      canSendRequest: false,
    });
  });

  it('returns pending_outgoing / pending_incoming from each side of a pending request', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const target = await seedPlayer();
    const sent = await svc.sendFriendRequest(caller.userId, target.userId);

    const fromCaller = await svc.getRelationships(caller.userId, [target.userId]);
    const fromTarget = await svc.getRelationships(target.userId, [caller.userId]);

    expect(fromCaller[0]).toMatchObject({ status: 'pending_outgoing', friendshipId: sent.id });
    expect(fromTarget[0]).toMatchObject({ status: 'pending_incoming', friendshipId: sent.id });
  });

  it('returns friends for an accepted pair', async () => {
    const { svc } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    await svc.sendFriendRequest(alice.userId, bob.userId);
    await svc.sendFriendRequest(bob.userId, alice.userId);

    const result = await svc.getRelationships(alice.userId, [bob.userId]);

    expect(result[0]).toMatchObject({ status: 'friends', canSendRequest: false });
  });

  it('preserves input order and duplicates, and batches reads (no N+1)', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const a = await seedPlayer();
    const b = await seedPlayer();

    const result = await svc.getRelationships(caller.userId, [b.userId, a.userId, b.userId]);

    expect(result.map((r) => r.userId)).toEqual([b.userId, a.userId, b.userId]);
  });
});

async function makeFriends(svc: SocialService, aUserId: string, bUserId: string) {
  const first = await svc.sendFriendRequest(aUserId, bUserId);
  await svc.sendFriendRequest(bUserId, aUserId); // mutual auto-accept
  return first;
}

describe('SocialService.removeFriend (real PG)', () => {
  it('dissolves an active friendship (caller as requester) and emits social.friendship.removed', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(svc, alice.userId, bob.userId);
    events.emit.mockClear();

    await svc.removeFriend(alice.userId, bob.userId);

    expect(events.emit).toHaveBeenCalledWith('social.friendship.removed', {
      friendshipId: friendshipRow.id,
      actorId: alice.userId,
      actorPlayerId: alice.id,
      otherUserId: bob.userId,
      reason: 'removed_by_player',
    });
    const [row] = await db.drizzle.db.select().from(friendship);
    expect(row?.removedAt).toBeInstanceOf(Date);
  });

  it('dissolves an active friendship (caller as addressee) and emits social.friendship.removed', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(svc, alice.userId, bob.userId);
    events.emit.mockClear();

    await svc.removeFriend(bob.userId, alice.userId);

    expect(events.emit).toHaveBeenCalledWith('social.friendship.removed', {
      friendshipId: friendshipRow.id,
      actorId: bob.userId,
      actorPlayerId: bob.id,
      otherUserId: alice.userId,
      reason: 'removed_by_player',
    });
  });

  it('emits a null actorPlayerId when the caller has no player row (BF-427 audit fix)', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const staffCallerId = randomUUID(); // an identity userId with no `player` row
    await db.drizzle.db.insert(friendship).values({
      requesterId: staffCallerId,
      addresseeId: alice.userId,
      acceptedAt: new Date(),
    });

    await svc.removeFriend(staffCallerId, alice.userId);

    expect(events.emit).toHaveBeenCalledWith(
      'social.friendship.removed',
      expect.objectContaining({ actorId: staffCallerId, actorPlayerId: null }),
    );
  });

  it('throws FriendshipNotFoundError when the pair was never friended', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();

    await expect(svc.removeFriend(alice.userId, bob.userId)).rejects.toBeInstanceOf(
      FriendshipNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws FriendshipNotFoundError when the request is still pending', async () => {
    const { svc } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    await svc.sendFriendRequest(alice.userId, bob.userId);

    await expect(svc.removeFriend(alice.userId, bob.userId)).rejects.toBeInstanceOf(
      FriendshipNotFoundError,
    );
  });

  it('throws FriendshipNotFoundError when the request was refused', async () => {
    const { svc } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    await db.drizzle.db
      .insert(friendship)
      .values({ requesterId: alice.userId, addresseeId: bob.userId, refusedAt: new Date() });

    await expect(svc.removeFriend(alice.userId, bob.userId)).rejects.toBeInstanceOf(
      FriendshipNotFoundError,
    );
  });

  it('throws FriendshipNotFoundError when already removed, and allows re-friending afterward (partial index)', async () => {
    const { svc } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    await makeFriends(svc, alice.userId, bob.userId);
    await svc.removeFriend(alice.userId, bob.userId);

    await expect(svc.removeFriend(alice.userId, bob.userId)).rejects.toBeInstanceOf(
      FriendshipNotFoundError,
    );

    const resent = await svc.sendFriendRequest(alice.userId, bob.userId);
    expect(resent.acceptedAt).toBeNull();
    const rows = await db.drizzle.db.select().from(friendship);
    expect(rows).toHaveLength(2);
  });
});

describe('SocialService.dissolveFriendshipOnBlock (real PG)', () => {
  it('silently no-ops when no friendship exists', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();

    await expect(
      svc.dissolveFriendshipOnBlock(db.drizzle.db, alice.userId, bob.userId),
    ).resolves.toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('silently no-ops when the request is only pending (not yet accepted)', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    await svc.sendFriendRequest(alice.userId, bob.userId);
    events.emit.mockClear();

    await svc.dissolveFriendshipOnBlock(db.drizzle.db, alice.userId, bob.userId);

    expect(events.emit).not.toHaveBeenCalled();
    const [row] = await db.drizzle.db.select().from(friendship);
    expect(row?.removedAt).toBeNull();
  });

  it('dissolves an active friendship and emits social.friendship.removed with reason blocked', async () => {
    const { svc, events } = makeService();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(svc, alice.userId, bob.userId);
    events.emit.mockClear();

    await svc.dissolveFriendshipOnBlock(db.drizzle.db, alice.userId, bob.userId);

    expect(events.emit).toHaveBeenCalledWith('social.friendship.removed', {
      friendshipId: friendshipRow.id,
      actorId: alice.userId,
      actorPlayerId: alice.id,
      otherUserId: bob.userId,
      reason: 'blocked',
    });
    const [row] = await db.drizzle.db.select().from(friendship);
    expect(row?.removedAt).toBeInstanceOf(Date);
  });
});

describe('SocialService.listFriends (real PG)', () => {
  it('returns only accepted, non-removed friendships involving the caller', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const friend = await seedPlayer({ displayName: 'Friend' });
    const pending = await seedPlayer({ displayName: 'Pending' });
    const refusedPlayer = await seedPlayer({ displayName: 'Refused' });
    const removedFriend = await seedPlayer({ displayName: 'Removed' });
    const strangerA = await seedPlayer({ displayName: 'StrangerA' });
    const strangerB = await seedPlayer({ displayName: 'StrangerB' });

    await makeFriends(svc, caller.userId, friend.userId);
    await svc.sendFriendRequest(caller.userId, pending.userId);
    await db.drizzle.db.insert(friendship).values({
      requesterId: caller.userId,
      addresseeId: refusedPlayer.userId,
      refusedAt: new Date(),
    });
    await makeFriends(svc, caller.userId, removedFriend.userId);
    await svc.removeFriend(caller.userId, removedFriend.userId);
    await makeFriends(svc, strangerA.userId, strangerB.userId);

    const result = await svc.listFriends(caller.userId, { page: 1, limit: 20 });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      userId: friend.userId,
      displayName: 'Friend',
      status: 'offline',
      lastSeenAt: null,
      isIgnored: false,
    });
  });

  it("derives isIgnored from the CALLER's own ignore state, not the friend's", async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const ignoredFriend = await seedPlayer({ displayName: 'IgnoredFriend' });
    const plainFriend = await seedPlayer({ displayName: 'PlainFriend' });
    await makeFriends(svc, caller.userId, ignoredFriend.userId);
    await makeFriends(svc, caller.userId, plainFriend.userId);
    await seedIgnore(caller.userId, ignoredFriend.userId);
    await seedIgnore(plainFriend.userId, caller.userId);

    const result = await svc.listFriends(caller.userId, { page: 1, limit: 20 });

    const byUserId = new Map(result.items.map((i) => [i.userId, i]));
    expect(byUserId.get(ignoredFriend.userId)).toMatchObject({ isIgnored: true });
    expect(byUserId.get(plainFriend.userId)).toMatchObject({ isIgnored: false });
  });

  it('derives status: online when lastSeenAt is within the online window, offline otherwise', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const recentlyActive = await seedPlayer({ lastSeenAt: new Date() });
    const staleActive = await seedPlayer({
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await makeFriends(svc, caller.userId, recentlyActive.userId);
    await makeFriends(svc, caller.userId, staleActive.userId);

    const result = await svc.listFriends(caller.userId, { page: 1, limit: 20 });

    const byUserId = new Map(result.items.map((i) => [i.userId, i]));
    expect(byUserId.get(recentlyActive.userId)).toMatchObject({ status: 'online' });
    expect(typeof byUserId.get(recentlyActive.userId)?.lastSeenAt).toBe('string');
    expect(byUserId.get(staleActive.userId)).toMatchObject({ status: 'offline' });
  });

  it('paginates results', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    for (let i = 0; i < 3; i++) {
      const friend = await seedPlayer({ displayName: `Friend${i}` });
      await makeFriends(svc, caller.userId, friend.userId);
    }

    const page1 = await svc.listFriends(caller.userId, { page: 1, limit: 2 });
    const page2 = await svc.listFriends(caller.userId, { page: 2, limit: 2 });

    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
    const allIds = new Set([...page1.items, ...page2.items].map((i) => i.userId));
    expect(allIds.size).toBe(3);
  });

  it('drops an entry whose player row is missing instead of rendering a blank name', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const friend = await seedPlayer({ displayName: 'Friend' });
    await makeFriends(svc, caller.userId, friend.userId);

    await db.drizzle.db.insert(friendship).values({
      requesterId: caller.userId,
      addresseeId: randomUUID(),
      acceptedAt: new Date(),
    });

    const result = await svc.listFriends(caller.userId, { page: 1, limit: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.userId).toBe(friend.userId);
  });

  it.each(['suspended', 'closed'] as const)(
    'drops a friend whose account is %s',
    async (status) => {
      const { svc } = makeService();
      const caller = await seedPlayer({ displayName: 'Caller' });
      const friend = await seedPlayer({ displayName: 'Friend' });
      const unavailableFriend = await seedPlayer({ displayName: 'Unavailable' });
      await makeFriends(svc, caller.userId, friend.userId);
      await makeFriends(svc, caller.userId, unavailableFriend.userId);
      await db.drizzle.db
        .update(player)
        .set({ status })
        .where(eq(player.userId, unavailableFriend.userId));

      const result = await svc.listFriends(caller.userId, { page: 1, limit: 20 });

      expect(result.items.map((i) => i.userId)).toEqual([friend.userId]);
    },
  );
});

describe('SocialService.acceptFriendRequest (real PG)', () => {
  it('accepts a pending incoming request and emits social.friend_request.accepted', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer({ displayName: 'Alice' });
    const addressee = await seedPlayer({ displayName: 'Bob' });
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    events.emit.mockClear();

    const result = await svc.acceptFriendRequest(addressee.userId, request.id);

    expect(result.id).toBe(request.id);
    expect(result.acceptedAt).toEqual(expect.any(String));
    expect(events.emit).toHaveBeenCalledWith('social.friend_request.accepted', {
      friendshipId: request.id,
      requesterId: requester.userId,
      addresseeId: addressee.userId,
      accepterId: addressee.userId,
      accepterDisplayName: 'Bob',
    });
    const [row] = await db.drizzle.db
      .select()
      .from(friendship)
      .where(eq(friendship.id, request.id));
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it('throws FriendRequestNotFoundError when the caller is not the addressee', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    events.emit.mockClear();

    // The requester (wrong side) tries to accept their own outgoing request.
    await expect(svc.acceptFriendRequest(requester.userId, request.id)).rejects.toBeInstanceOf(
      FriendRequestNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws FriendRequestNotFoundError on a nonexistent friendshipId', async () => {
    const { svc } = makeService();
    const addressee = await seedPlayer();

    await expect(svc.acceptFriendRequest(addressee.userId, randomUUID())).rejects.toBeInstanceOf(
      FriendRequestNotFoundError,
    );
  });

  it('throws FriendRequestNotFoundError on a double-accept', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    await svc.acceptFriendRequest(addressee.userId, request.id);
    events.emit.mockClear();

    await expect(svc.acceptFriendRequest(addressee.userId, request.id)).rejects.toBeInstanceOf(
      FriendRequestNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'addressee blocked requester',
      (requesterId: string, addresseeId: string) => seedBlock(addresseeId, requesterId),
    ],
    [
      'requester blocked addressee',
      (requesterId: string, addresseeId: string) => seedBlock(requesterId, addresseeId),
    ],
  ])(
    'throws FriendRequestUnavailableError when a block landed after the request was sent (%s)',
    async (_label, seedTheBlock) => {
      const { svc, events } = makeService();
      const requester = await seedPlayer();
      const addressee = await seedPlayer();
      const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
      await seedTheBlock(requester.userId, addressee.userId);
      events.emit.mockClear();

      await expect(svc.acceptFriendRequest(addressee.userId, request.id)).rejects.toBeInstanceOf(
        FriendRequestUnavailableError,
      );
      expect(events.emit).not.toHaveBeenCalled();
      const [row] = await db.drizzle.db
        .select()
        .from(friendship)
        .where(eq(friendship.id, request.id));
      expect(row?.acceptedAt).toBeNull();
    },
  );
});

describe('SocialService.declineFriendRequest (real PG)', () => {
  it('refuses a pending incoming request, emits social.friend_request.declined, and never emits a notification-triggering event', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    events.emit.mockClear();

    await svc.declineFriendRequest(addressee.userId, request.id);

    expect(events.emit).toHaveBeenCalledWith('social.friend_request.declined', {
      friendshipId: request.id,
      requesterId: requester.userId,
      addresseeId: addressee.userId,
    });
    expect(events.emit).not.toHaveBeenCalledWith(
      'social.friend_request.accepted',
      expect.anything(),
    );
    const [row] = await db.drizzle.db
      .select()
      .from(friendship)
      .where(eq(friendship.id, request.id));
    expect(row?.refusedAt).toBeNull();
    expect(row?.removedAt).toBeInstanceOf(Date);
  });

  it('allows re-requesting the pair after a decline (regression: previously blocked forever)', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);

    await svc.declineFriendRequest(addressee.userId, request.id);

    const resent = await svc.sendFriendRequest(requester.userId, addressee.userId);
    expect(resent.id).not.toBe(request.id);
    expect(resent.acceptedAt).toBeNull();
    const rows = await db.drizzle.db.select().from(friendship);
    expect(rows).toHaveLength(2);
  });

  it('throws FriendRequestNotFoundError when the caller is not the addressee', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);

    await expect(svc.declineFriendRequest(requester.userId, request.id)).rejects.toBeInstanceOf(
      FriendRequestNotFoundError,
    );
  });
});

describe('SocialService.cancelFriendRequest (real PG)', () => {
  it('soft-removes a pending outgoing request, emits social.friend_request.cancelled, and never emits a notification-triggering event', async () => {
    const { svc, events } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);
    events.emit.mockClear();

    await svc.cancelFriendRequest(requester.userId, request.id);

    expect(events.emit).toHaveBeenCalledWith('social.friend_request.cancelled', {
      friendshipId: request.id,
      requesterId: requester.userId,
      addresseeId: addressee.userId,
    });
    expect(events.emit).not.toHaveBeenCalledWith(
      'social.friend_request.accepted',
      expect.anything(),
    );
    const [row] = await db.drizzle.db
      .select()
      .from(friendship)
      .where(eq(friendship.id, request.id));
    expect(row?.removedAt).toBeInstanceOf(Date);
    expect(row?.refusedAt).toBeNull();
  });

  it('allows re-requesting the pair after a cancel (new behavior enabled by the constraint change)', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);

    await svc.cancelFriendRequest(requester.userId, request.id);

    const resent = await svc.sendFriendRequest(requester.userId, addressee.userId);
    expect(resent.id).not.toBe(request.id);
    expect(resent.acceptedAt).toBeNull();
    const rows = await db.drizzle.db.select().from(friendship);
    expect(rows).toHaveLength(2);
  });

  it('throws FriendRequestNotFoundError when the caller is not the requester', async () => {
    const { svc } = makeService();
    const requester = await seedPlayer();
    const addressee = await seedPlayer();
    const request = await svc.sendFriendRequest(requester.userId, addressee.userId);

    await expect(svc.cancelFriendRequest(addressee.userId, request.id)).rejects.toBeInstanceOf(
      FriendRequestNotFoundError,
    );
  });
});

describe('SocialService.listFriendRequests (real PG)', () => {
  it('lists incoming pending requests, newest first, with mutualFriendsCount', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const senderA = await seedPlayer({ displayName: 'SenderA' });
    const senderB = await seedPlayer({ displayName: 'SenderB' });
    await svc.sendFriendRequest(senderA.userId, caller.userId);
    await svc.sendFriendRequest(senderB.userId, caller.userId);

    const result = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 1,
      limit: 20,
    });

    expect(result.total).toBe(2);
    // newest first: senderB requested after senderA.
    expect(result.items.map((i) => i.userId)).toEqual([senderB.userId, senderA.userId]);
    for (const item of result.items) {
      expect(item.direction).toBe('incoming');
      expect(item.mutualFriendsCount).toBe(0);
    }
  });

  it('lists outgoing pending requests with a null mutualFriendsCount', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const target = await seedPlayer({ displayName: 'Target' });
    await svc.sendFriendRequest(caller.userId, target.userId);

    const result = await svc.listFriendRequests(caller.userId, {
      direction: 'outgoing',
      page: 1,
      limit: 20,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      userId: target.userId,
      displayName: 'Target',
      direction: 'outgoing',
      mutualFriendsCount: null,
    });
  });

  it('excludes accepted, refused, and removed rows', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const accepted = await seedPlayer();
    const refused = await seedPlayer();
    const cancelled = await seedPlayer();
    const pending = await seedPlayer({ displayName: 'StillPending' });
    await makeFriends(svc, caller.userId, accepted.userId);
    const refusedReq = await svc.sendFriendRequest(refused.userId, caller.userId);
    await svc.declineFriendRequest(caller.userId, refusedReq.id);
    const cancelledReq = await svc.sendFriendRequest(caller.userId, cancelled.userId);
    await svc.cancelFriendRequest(caller.userId, cancelledReq.id);
    await svc.sendFriendRequest(pending.userId, caller.userId);

    const incoming = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 1,
      limit: 20,
    });

    expect(incoming.total).toBe(1);
    expect(incoming.items[0]?.userId).toBe(pending.userId);
  });

  it.each(['suspended', 'closed'] as const)(
    'drops a pending sender whose account is %s',
    async (status) => {
      const { svc } = makeService();
      const caller = await seedPlayer();
      const sender = await seedPlayer({ displayName: 'Sender' });
      const unavailableSender = await seedPlayer({ displayName: 'Unavailable' });
      await svc.sendFriendRequest(sender.userId, caller.userId);
      await svc.sendFriendRequest(unavailableSender.userId, caller.userId);
      await db.drizzle.db
        .update(player)
        .set({ status })
        .where(eq(player.userId, unavailableSender.userId));

      const result = await svc.listFriendRequests(caller.userId, {
        direction: 'incoming',
        page: 1,
        limit: 20,
      });

      expect(result.items.map((i) => i.userId)).toEqual([sender.userId]);
    },
  );

  it.each([
    [
      'caller blocked the sender',
      (callerId: string, senderId: string) => seedBlock(callerId, senderId),
    ],
    [
      'sender blocked the caller',
      (callerId: string, senderId: string) => seedBlock(senderId, callerId),
    ],
  ])('drops an incoming pending sender who is blocked (%s)', async (_label, seedTheBlock) => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const sender = await seedPlayer({ displayName: 'Sender' });
    const blockedSender = await seedPlayer({ displayName: 'Blocked' });
    await svc.sendFriendRequest(sender.userId, caller.userId);
    await svc.sendFriendRequest(blockedSender.userId, caller.userId);
    await seedTheBlock(caller.userId, blockedSender.userId);

    const result = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 1,
      limit: 20,
    });

    expect(result.items.map((i) => i.userId)).toEqual([sender.userId]);
  });

  it('drops an outgoing pending target who is blocked', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    const target = await seedPlayer({ displayName: 'Target' });
    await svc.sendFriendRequest(caller.userId, target.userId);
    await seedBlock(target.userId, caller.userId);

    const result = await svc.listFriendRequests(caller.userId, {
      direction: 'outgoing',
      page: 1,
      limit: 20,
    });

    expect(result.items).toEqual([]);
  });

  it('paginates results', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer();
    for (let i = 0; i < 3; i++) {
      const sender = await seedPlayer({ displayName: `Sender${i}` });
      await svc.sendFriendRequest(sender.userId, caller.userId);
    }

    const page1 = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 1,
      limit: 2,
    });
    const page2 = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 2,
      limit: 2,
    });

    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
  });

  it('computes mutualFriendsCount via one batched query across exactly 2 shared accepted friends', async () => {
    const { svc } = makeService();
    const caller = await seedPlayer({ displayName: 'Caller' });
    const requester = await seedPlayer({ displayName: 'Requester' });
    const mutualA = await seedPlayer({ displayName: 'MutualA' });
    const mutualB = await seedPlayer({ displayName: 'MutualB' });
    const callerOnlyFriend = await seedPlayer({ displayName: 'CallerOnlyFriend' });
    const requesterOnlyFriend = await seedPlayer({ displayName: 'RequesterOnlyFriend' });

    // Shared friends: caller <-> mutualA/mutualB, requester <-> mutualA/mutualB.
    await makeFriends(svc, caller.userId, mutualA.userId);
    await makeFriends(svc, caller.userId, mutualB.userId);
    await makeFriends(svc, requester.userId, mutualA.userId);
    await makeFriends(svc, requester.userId, mutualB.userId);
    // Non-shared friends on each side - must not inflate the count.
    await makeFriends(svc, caller.userId, callerOnlyFriend.userId);
    await makeFriends(svc, requester.userId, requesterOnlyFriend.userId);

    await svc.sendFriendRequest(requester.userId, caller.userId);

    const result = await svc.listFriendRequests(caller.userId, {
      direction: 'incoming',
      page: 1,
      limit: 20,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      userId: requester.userId,
      mutualFriendsCount: 2,
    });
  });
});
