import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, or } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { friendship } from '@openora/core/engagement/schema/social';
import {
  FriendListEntrySchema,
  FriendRequestEntrySchema,
  FriendshipSchema,
  RelationshipSchema,
} from '@openora/core/engagement/contracts/social';
import { bootE2e, closeE2e, newPlayer, type E2e } from '../index.js';
import { ErrorBodySchema } from './support/identity.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

type Member = Awaited<ReturnType<typeof newPlayer>>;

const FriendsPageSchema = z.object({ items: z.array(FriendListEntrySchema), total: z.number() });
const RequestsPageSchema = z.object({
  items: z.array(FriendRequestEntrySchema),
  total: z.number(),
});
const RelationshipsSchema = z.array(RelationshipSchema);

const newMember = (prefix: string) => newPlayer(e2e.app, prefix);

async function sendRequest(from: Member, to: Member) {
  return from.client.post('/social/friend-requests', { targetUserId: to.userId });
}

async function requestId(from: Member, to: Member) {
  const res = await sendRequest(from, to);
  expect(res.status).toBe(200);
  return FriendshipSchema.parse(await res.json()).id;
}

async function befriend(a: Member, b: Member) {
  const id = await requestId(a, b);
  const res = await b.client.post(`/social/friend-requests/${id}/accept`);
  expect(res.status).toBe(200);
  return id;
}

async function listFriends(who: Member) {
  const res = await who.client.get('/social/friends?page=1&limit=50');
  expect(res.status).toBe(200);
  return FriendsPageSchema.parse(await res.json()).items.map((item) => item.userId);
}

async function listRequests(who: Member, direction: 'incoming' | 'outgoing') {
  const res = await who.client.get(
    `/social/friend-requests?direction=${direction}&page=1&limit=50`,
  );
  expect(res.status).toBe(200);
  return RequestsPageSchema.parse(await res.json()).items;
}

async function errorOf(res: Response) {
  return ErrorBodySchema.parse(await res.json());
}

async function pairRows(a: Member, b: Member) {
  const rows = await db()
    .select()
    .from(friendship)
    .where(or(eq(friendship.requesterId, a.userId), eq(friendship.addresseeId, a.userId)));
  return rows.filter((row) => row.requesterId === b.userId || row.addresseeId === b.userId);
}

async function relationshipsOf(who: Member, targets: Member[]) {
  const res = await who.client.post('/social/relationships', {
    userIds: targets.map((target) => target.userId),
  });
  expect(res.status).toBe(200);
  return RelationshipsSchema.parse(await res.json());
}

async function block(blocker: Member, blocked: Member) {
  const res = await blocker.client.post('/chat/blocks', { blockedId: blocked.userId });
  expect(res.status).toBe(200);
}

describe('friend requests', () => {
  it('a player sends a friend request and the target sees it as incoming', async () => {
    const sender = await newMember('fr-send');
    const target = await newMember('fr-target');
    const bystander = await newMember('fr-bystander');

    const res = await sendRequest(sender, target);

    expect(res.status).toBe(200);
    const created = FriendshipSchema.parse(await res.json());
    expect(created).toEqual(
      expect.objectContaining({
        requesterId: sender.userId,
        addresseeId: target.userId,
        acceptedAt: null,
        refusedAt: null,
      }),
    );
    expect(await listRequests(target, 'incoming')).toEqual([
      expect.objectContaining({
        friendshipId: created.id,
        userId: sender.userId,
        direction: 'incoming',
      }),
    ]);
    expect(await listRequests(sender, 'outgoing')).toEqual([
      expect.objectContaining({ friendshipId: created.id, userId: target.userId }),
    ]);
    expect(await listRequests(bystander, 'incoming')).toEqual([]);
    expect(await listFriends(target)).toEqual([]);
  });

  it('the target accepts and both players list each other as friends', async () => {
    const sender = await newMember('fr-acc-s');
    const target = await newMember('fr-acc-t');
    const id = await requestId(sender, target);

    const res = await target.client.post(`/social/friend-requests/${id}/accept`);

    expect(res.status).toBe(200);
    expect(FriendshipSchema.parse(await res.json()).acceptedAt).not.toBeNull();
    expect(await listFriends(sender)).toEqual([target.userId]);
    expect(await listFriends(target)).toEqual([sender.userId]);
    expect(await listRequests(target, 'incoming')).toEqual([]);
  });

  it('the target declines and neither player is listed as a friend', async () => {
    const sender = await newMember('fr-dec-s');
    const target = await newMember('fr-dec-t');
    const id = await requestId(sender, target);

    const res = await target.client.post(`/social/friend-requests/${id}/decline`);

    expect(res.status).toBe(200);
    expect(await listFriends(sender)).toEqual([]);
    expect(await listFriends(target)).toEqual([]);
    expect(await listRequests(target, 'incoming')).toEqual([]);
    expect(await listRequests(sender, 'outgoing')).toEqual([]);
  });

  it('the sender cancels a pending request and it disappears for the target', async () => {
    const sender = await newMember('fr-can-s');
    const target = await newMember('fr-can-t');
    const id = await requestId(sender, target);
    expect(await listRequests(target, 'incoming')).toHaveLength(1);

    const res = await sender.client.del(`/social/friend-requests/${id}`);

    expect(res.status).toBe(200);
    expect(await listRequests(target, 'incoming')).toEqual([]);
    const again = await sender.client.del(`/social/friend-requests/${id}`);
    expect(again.status).toBe(404);
    const accept = await target.client.post(`/social/friend-requests/${id}/accept`);
    expect(accept.status).toBe(404);
  });

  it('a player cannot send a request to themselves', async () => {
    const me = await newMember('fr-self');

    const res = await sendRequest(me, me);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('BAD_REQUEST');
    expect(
      await db().select().from(friendship).where(eq(friendship.requesterId, me.userId)),
    ).toEqual([]);
  });

  it('a repeated request to the same player does not create a second pending row', async () => {
    const sender = await newMember('fr-dup-s');
    const target = await newMember('fr-dup-t');
    await requestId(sender, target);

    const res = await sendRequest(sender, target);

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: 'A friend request to this player is already pending',
      }),
    );
    expect(await pairRows(sender, target)).toHaveLength(1);
    expect(await listRequests(target, 'incoming')).toHaveLength(1);
  });

  it('a player cannot accept or decline a request addressed to someone else', async () => {
    const sender = await newMember('fr-own-s');
    const target = await newMember('fr-own-t');
    const intruder = await newMember('fr-own-i');
    const id = await requestId(sender, target);

    const intruderAccept = await intruder.client.post(`/social/friend-requests/${id}/accept`);
    const intruderDecline = await intruder.client.post(`/social/friend-requests/${id}/decline`);
    const senderAccept = await sender.client.post(`/social/friend-requests/${id}/accept`);
    const senderDecline = await sender.client.post(`/social/friend-requests/${id}/decline`);

    expect([intruderAccept.status, intruderDecline.status]).toEqual([404, 404]);
    expect([senderAccept.status, senderDecline.status]).toEqual([404, 404]);
    const [row] = await pairRows(sender, target);
    expect(row).toEqual(expect.objectContaining({ id, acceptedAt: null, removedAt: null }));
    expect(await listFriends(intruder)).toEqual([]);
    expect(await listRequests(target, 'incoming')).toHaveLength(1);
  });

  it('a request to a player who blocked the sender is refused', async () => {
    const sender = await newMember('fr-blk-s');
    const target = await newMember('fr-blk-t');
    await block(target, sender);

    const res = await sendRequest(sender, target);

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: 'This player cannot receive friend requests right now',
      }),
    );
    expect(await pairRows(sender, target)).toEqual([]);
    expect(await listRequests(target, 'incoming')).toEqual([]);
  });

  it('an unauthenticated caller cannot send or list requests', async () => {
    const target = await newMember('fr-anon-t');

    const send = await e2e.app.app.request('/social/friend-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: target.userId }),
    });
    const list = await e2e.app.app.request(
      '/social/friend-requests?direction=incoming&page=1&limit=50',
    );

    expect(send.status).toBe(401);
    expect(list.status).toBe(401);
    expect(
      await db().select().from(friendship).where(eq(friendship.addresseeId, target.userId)),
    ).toEqual([]);
  });
});

describe('relationships and privacy', () => {
  it('relationships between the caller and a list of players report friend, pending in, pending out and none', async () => {
    const me = await newMember('rel-me');
    const friend = await newMember('rel-friend');
    const incoming = await newMember('rel-in');
    const outgoing = await newMember('rel-out');
    const stranger = await newMember('rel-none');
    const friendshipId = await befriend(me, friend);
    const incomingId = await requestId(incoming, me);
    const outgoingId = await requestId(me, outgoing);

    const relationships = await relationshipsOf(me, [friend, incoming, outgoing, stranger]);

    expect(relationships).toEqual([
      { userId: friend.userId, status: 'friends', friendshipId, canSendRequest: false },
      {
        userId: incoming.userId,
        status: 'pending_incoming',
        friendshipId: incomingId,
        canSendRequest: false,
      },
      {
        userId: outgoing.userId,
        status: 'pending_outgoing',
        friendshipId: outgoingId,
        canSendRequest: false,
      },
      { userId: stranger.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);
  });

  it('a player who turned off friend requests in privacy settings cannot be sent a request', async () => {
    const sender = await newMember('priv-s');
    const target = await newMember('priv-t');
    await db()
      .update(player)
      .set({ allowFriendRequests: false })
      .where(eq(player.userId, target.userId));

    const res = await sendRequest(sender, target);

    expect(res.status).toBe(409);
    const body = await errorOf(res);
    expect(body.data).toEqual(expect.objectContaining({ code: 'FRIEND_REQUESTS_DISABLED' }));
    expect(await pairRows(sender, target)).toEqual([]);
    const [relationship] = await relationshipsOf(sender, [target]);
    expect(relationship).toEqual(
      expect.objectContaining({ status: 'none', canSendRequest: false }),
    );
  });

  it('removing a friend removes the friendship for both players', async () => {
    const a = await newMember('rm-a');
    const b = await newMember('rm-b');
    await befriend(a, b);
    expect(await listFriends(b)).toEqual([a.userId]);

    const res = await a.client.del(`/social/friends/${b.userId}`);

    expect(res.status).toBe(200);
    expect(await listFriends(a)).toEqual([]);
    expect(await listFriends(b)).toEqual([]);
    const again = await b.client.del(`/social/friends/${a.userId}`);
    expect(again.status).toBe(404);
    const [relationship] = await relationshipsOf(a, [b]);
    expect(relationship).toEqual(expect.objectContaining({ status: 'none' }));
  });

  it('blocking a friend dissolves the friendship', async () => {
    const blocker = await newMember('blk-a');
    const blocked = await newMember('blk-b');
    await befriend(blocker, blocked);
    expect(await listFriends(blocked)).toEqual([blocker.userId]);

    await block(blocker, blocked);

    expect(await listFriends(blocker)).toEqual([]);
    expect(await listFriends(blocked)).toEqual([]);
    const [fromBlocker] = await relationshipsOf(blocker, [blocked]);
    const [fromBlocked] = await relationshipsOf(blocked, [blocker]);
    expect(fromBlocker).toEqual(expect.objectContaining({ status: 'blocked_by_me' }));
    expect(fromBlocked).toEqual(expect.objectContaining({ status: 'unavailable' }));
  });
});
