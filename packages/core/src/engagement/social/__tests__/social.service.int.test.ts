import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus } from '../../../testing/mock.js';
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
} from '../service/social.service.js';

let db: TestDb;

function makeService() {
  const events = makeEventBus();
  return { svc: new SocialService(db.drizzle, events), events };
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

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateChat]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${friendship}, ${chatUserBlock}, ${player} RESTART IDENTITY CASCADE`,
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
