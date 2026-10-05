import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { CHAT_REALTIME_TRANSPORT, chatChannel } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { chatRoomInvite, chatRoomMember } from '@openora/core/engagement/schema/chat';
import {
  CHAT_MEMBER_JOINED_SIGNAL,
  ChatRoomInviteCandidateSchema,
  ChatRoomInviteLookupSchema,
  ChatRoomInviteSchema,
  ChatRoomMemberSchema,
  ChatRoomSchema,
  MyChatRoomInviteSchema,
  type ChatRoom,
} from '@openora/core/engagement/contracts/chat';
import {
  setupTestDb,
  bootTestApp,
  asAdmin,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const WAIT = { timeout: 10_000, interval: 100 };

type Chatter = Awaited<ReturnType<typeof registerAndMaterializePlayer>> & { username: string };

async function registerChatter(prefix: string, email?: string): Promise<Chatter> {
  const username = `${prefix.slice(0, 7)}_${randomInt(10 ** 9, 10 ** 10)}`;
  const registered = await registerAndMaterializePlayer(app, {
    email: email ?? `${username}@e2e.test`,
    username,
  });
  return { ...registered, username };
}

async function createRoom(owner: Chatter) {
  const created = await owner.client.post('/chat/rooms/private', { name: `room-${randomUUID()}` });
  expect(created.status).toBe(200);
  return ChatRoomSchema.parse(await created.json());
}

async function joinByCode(member: Chatter, room: ChatRoom) {
  const joined = await member.client.post('/chat/rooms/join', { joinCode: room.joinCode });
  expect(joined.status).toBe(200);
}

async function configureRoom(
  owner: Chatter,
  room: ChatRoom,
  values: { moderatorInvite?: boolean; lockRoom?: boolean },
) {
  const res = await owner.client.patch(`/chat/rooms/${room.id}/configuration`, values);
  expect(res.status).toBe(200);
}

async function addModerator(owner: Chatter, room: ChatRoom) {
  const moderator = await registerChatter('keeper');
  await joinByCode(moderator, room);
  const promoted = await owner.client.post(
    `/chat/rooms/${room.id}/members/${moderator.userId}/role`,
    { role: 'moderator' },
  );
  expect(promoted.status).toBe(200);
  return moderator;
}

function invite(actor: Chatter, room: ChatRoom, userId: string) {
  return actor.client.post(`/chat/rooms/${room.id}/invites`, { userId });
}

async function sendInvite(actor: Chatter, room: ChatRoom, invitee: Chatter) {
  const res = await invite(actor, room, invitee.userId);
  expect(res.status).toBe(200);
  return ChatRoomInviteSchema.parse(await res.json());
}

async function expectRejected(res: Response, status: number, reason: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { data?: { reason?: string } };
  expect(body.data?.reason).toBe(reason);
}

async function myInvites(invitee: Chatter) {
  const res = await invitee.client.get('/chat/invites');
  expect(res.status).toBe(200);
  return MyChatRoomInviteSchema.array().parse(await res.json());
}

async function roomMemberIds(owner: Chatter, room: ChatRoom) {
  const res = await owner.client.get(`/chat/rooms/${room.id}/members`);
  expect(res.status).toBe(200);
  return ChatRoomMemberSchema.array()
    .parse(await res.json())
    .map((member) => member.userId);
}

async function inviteRow(inviteId: string) {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select()
    .from(chatRoomInvite)
    .where(eq(chatRoomInvite.id, inviteId));
  return row;
}

async function watchRoomSignals(roomId: string) {
  const transport = app.container.get(CHAT_REALTIME_TRANSPORT);
  const probe = `probe-${randomUUID()}`;
  const received: { name: string; payload: unknown }[] = [];
  const unsubscribe = transport.subscribeSignal?.(chatChannel(roomId), (signal) => {
    received.push(signal);
  });
  await vi.waitFor(
    async () => {
      await transport.signal?.(chatChannel(roomId), probe, {});
      expect(received.some((signal) => signal.name === probe)).toBe(true);
    },
    { timeout: 10_000, interval: 250 },
  );
  return { received, unsubscribe: () => unsubscribe?.() };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('chat room invites: who may invite', () => {
  it('lets the owner invite', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);

    const sent = await sendInvite(owner, room, invitee);

    expect(sent).toMatchObject({
      roomId: room.id,
      inviterId: owner.userId,
      inviteeId: invitee.userId,
      status: 'pending',
      respondedAt: null,
    });
  });

  it('lets a moderator invite only when the room allows moderator invites', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);
    const invitee = await registerChatter('guest');

    await expectRejected(await invite(moderator, room, invitee.userId), 403, 'forbidden');
    await configureRoom(owner, room, { moderatorInvite: true });
    await sendInvite(moderator, room, invitee);
  });

  it('refuses a plain member even when moderator invites are on', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('member');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    await joinByCode(member, room);
    await configureRoom(owner, room, { moderatorInvite: true });

    await expectRejected(await invite(member, room, invitee.userId), 403, 'forbidden');
  });

  it('answers a non-member as if the room did not exist', async () => {
    const owner = await registerChatter('host');
    const outsider = await registerChatter('outside');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);

    expect((await invite(outsider, room, invitee.userId)).status).toBe(404);
    expect(
      (await outsider.client.get(`/chat/rooms/${room.id}/invite-candidates?q=gue`)).status,
    ).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);

    const res = await app.app.request(`/chat/rooms/${room.id}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: owner.userId }),
    });

    expect(res.status).toBe(401);
  });
});

describe('chat room invites: rejections', () => {
  it('refuses inviting yourself', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);

    await expectRejected(await invite(owner, room, owner.userId), 400, 'self');
  });

  it('refuses a staff account', async () => {
    const owner = await registerChatter('host');
    const staff = await registerChatter('crew');
    const room = await createRoom(owner);
    await app.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ role: 'admin' })
      .where(eq(user.id, staff.userId));

    await expectRejected(await invite(owner, room, staff.userId), 400, 'not_player');
  });

  it('refuses a player who blocked the inviter, without saying why', async () => {
    const owner = await registerChatter('host');
    const blocker = await registerChatter('blocker');
    const room = await createRoom(owner);
    expect((await blocker.client.post('/chat/blocks', { blockedId: owner.userId })).status).toBe(
      200,
    );

    await expectRejected(await invite(owner, room, blocker.userId), 403, 'unavailable');
  });

  it('refuses a suspended player', async () => {
    const owner = await registerChatter('host');
    const suspended = await registerChatter('susp');
    const room = await createRoom(owner);
    await app.container
      .get(DRIZZLE)
      .db.update(player)
      .set({ status: 'suspended' })
      .where(eq(player.userId, suspended.userId));

    await expectRejected(await invite(owner, room, suspended.userId), 403, 'unavailable');
  });

  it('refuses a player banned from the room', async () => {
    const owner = await registerChatter('host');
    const banned = await registerChatter('banned');
    const room = await createRoom(owner);
    await joinByCode(banned, room);
    const ban = await owner.client.post(`/chat/rooms/${room.id}/ban`, {
      userId: banned.userId,
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    await expectRejected(await invite(owner, room, banned.userId), 403, 'banned');
  });

  it('refuses a player under a platform chat ban', async () => {
    const owner = await registerChatter('host');
    const banned = await registerChatter('banned');
    const room = await createRoom(owner);
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    await expectRejected(await invite(owner, room, banned.userId), 403, 'unavailable');
  });

  it('refuses a player who is already a member', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('member');
    const room = await createRoom(owner);
    await joinByCode(member, room);

    await expectRejected(await invite(owner, room, member.userId), 409, 'member');
  });

  it('refuses a second pending invite for the same player', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    await sendInvite(owner, room, invitee);

    await expectRejected(await invite(owner, room, invitee.userId), 409, 'invited');
  });

  it('refuses an inviter under a platform chat ban', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: owner.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    expect((await invite(owner, room, invitee.userId)).status).toBe(403);
    expect(await myInvites(invitee)).toEqual([]);
  });

  it('refuses inviting into a locked room', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    await configureRoom(owner, room, { lockRoom: true });

    await expectRejected(await invite(owner, room, invitee.userId), 403, 'locked');
  });
});

describe('chat room invites: accepting', () => {
  it('adds the member, signals the room, notifies the invitee and records the audit trail', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    await vi.waitFor(async () => {
      const listRes = await invitee.client.get('/notifications');
      expect(listRes.status).toBe(200);
      const { items } = (await listRes.json()) as {
        items: { type: string; title: string; body: string; data: Record<string, string> }[];
      };
      const row = items.find((n) => n.type === 'chat.room_invite.received');
      expect(row).toMatchObject({
        title: 'Room invite',
        body: `${owner.username} invited you to a private room`,
        data: {
          inviteId: sent.id,
          roomId: room.id,
          inviterId: owner.userId,
          roomName: room.name,
        },
      });
    }, WAIT);

    const listed = await myInvites(invitee);
    expect(listed).toEqual([
      {
        id: sent.id,
        roomId: room.id,
        roomName: room.name,
        inviterId: owner.userId,
        inviterUsername: owner.username,
        createdAt: sent.createdAt,
      },
    ]);

    const signals = await watchRoomSignals(room.id);
    try {
      const accepted = await invitee.client.post(`/chat/invites/${sent.id}/accept`);
      expect(accepted.status).toBe(200);
      expect(ChatRoomSchema.parse(await accepted.json()).id).toBe(room.id);

      await vi.waitFor(() => {
        expect(signals.received).toContainEqual({
          name: CHAT_MEMBER_JOINED_SIGNAL,
          payload: { roomId: room.id, userId: invitee.userId },
        });
      }, WAIT);
    } finally {
      signals.unsubscribe();
    }

    expect(await roomMemberIds(owner, room)).toContain(invitee.userId);
    expect(await inviteRow(sent.id)).toMatchObject({ status: 'accepted' });
    expect(await myInvites(invitee)).toEqual([]);
    const sentMessage = await invitee.client.post(`/chat/rooms/${room.id}/messages`, {
      content: 'hello',
    });
    expect(sentMessage.status).toBe(200);

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${sent.id}&action=chat.room.invite.accepted`,
      );
      expect(auditRes.status).toBe(200);
      const { items } = (await auditRes.json()) as { items: unknown[] };
      expect(items[0]).toMatchObject({
        actorType: 'player',
        actorId: invitee.playerId,
        resourceType: 'chat_room_invite',
      });
    }, WAIT);
  });

  it('signals the room when a player joins by code', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('member');
    const room = await createRoom(owner);

    const signals = await watchRoomSignals(room.id);
    try {
      await joinByCode(member, room);
      await vi.waitFor(() => {
        expect(signals.received).toContainEqual({
          name: CHAT_MEMBER_JOINED_SIGNAL,
          payload: { roomId: room.id, userId: member.userId },
        });
      }, WAIT);
    } finally {
      signals.unsubscribe();
    }
  });

  it('does not signal a staff account joining', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('member');
    const room = await createRoom(owner);

    const signals = await watchRoomSignals(room.id);
    try {
      expect((await admin.post(`/backoffice/chat/rooms/${room.id}/join`)).status).toBe(200);
      await joinByCode(member, room);
      await vi.waitFor(() => {
        expect(signals.received).toContainEqual({
          name: CHAT_MEMBER_JOINED_SIGNAL,
          payload: { roomId: room.id, userId: member.userId },
        });
      }, WAIT);
      expect(signals.received.filter((s) => s.name === CHAT_MEMBER_JOINED_SIGNAL)).toHaveLength(1);
    } finally {
      signals.unsubscribe();
    }
  });

  it('refuses an invite addressed to someone else', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const other = await registerChatter('other');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    expect((await other.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
    expect((await other.client.post(`/chat/invites/${sent.id}/decline`)).status).toBe(404);
    expect(await inviteRow(sent.id)).toMatchObject({ status: 'pending' });
  });

  it('refuses accepting once the room is locked', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);
    await configureRoom(owner, room, { lockRoom: true });

    await expectRejected(
      await invitee.client.post(`/chat/invites/${sent.id}/accept`),
      403,
      'locked',
    );
    expect(await roomMemberIds(owner, room)).not.toContain(invitee.userId);
  });

  it('refuses accepting after the invitee blocked the inviter', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);
    expect((await invitee.client.post('/chat/blocks', { blockedId: owner.userId })).status).toBe(
      200,
    );

    await expectRejected(
      await invitee.client.post(`/chat/invites/${sent.id}/accept`),
      403,
      'blocked',
    );
  });

  it('refuses accepting under a platform chat ban', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: invitee.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(403);
    expect(await roomMemberIds(owner, room)).not.toContain(invitee.userId);
  });
});

describe('chat room invites: declining and expiry', () => {
  it('declines an invite and lets the owner invite again', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const first = await sendInvite(owner, room, invitee);

    const declined = await invitee.client.post(`/chat/invites/${first.id}/decline`);
    expect(declined.status).toBe(200);
    expect(await declined.json()).toEqual({ success: true });
    expect(await inviteRow(first.id)).toMatchObject({ status: 'declined' });
    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${first.id}/accept`)).status).toBe(404);

    const second = await sendInvite(owner, room, invitee);
    expect(second.id).not.toBe(first.id);
    expect((await myInvites(invitee)).map((row) => row.id)).toEqual([second.id]);
  });

  it("voids a moderator's invites once moderator invites are switched off", async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);
    await configureRoom(owner, room, { moderatorInvite: true });
    const sent = await sendInvite(moderator, room, invitee);
    await configureRoom(owner, room, { moderatorInvite: false });

    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
    expect(await roomMemberIds(owner, room)).not.toContain(invitee.userId);
    await sendInvite(owner, room, invitee);
  });

  it('treats an invite older than seven days as gone and allows a fresh one', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const stale = await sendInvite(owner, room, invitee);
    await app.container
      .get(DRIZZLE)
      .db.update(chatRoomInvite)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(chatRoomInvite.id, stale.id));

    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${stale.id}/accept`)).status).toBe(404);
    expect((await invitee.client.post(`/chat/invites/${stale.id}/decline`)).status).toBe(404);
    const statuses = await owner.client.post(`/chat/rooms/${room.id}/invite-statuses`, {
      userIds: [invitee.userId],
    });
    expect(ChatRoomInviteLookupSchema.array().parse(await statuses.json())).toEqual([
      { userId: invitee.userId, inviteStatus: 'available' },
    ]);

    const fresh = await sendInvite(owner, room, invitee);
    expect((await myInvites(invitee)).map((row) => row.id)).toEqual([fresh.id]);
    expect(await inviteRow(stale.id)).toMatchObject({ status: 'expired', respondedAt: null });

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${stale.id}&action=chat.room.invite.expired`,
      );
      expect(auditRes.status).toBe(200);
      const { items } = (await auditRes.json()) as { items: unknown[] };
      expect(items[0]).toMatchObject({
        actorType: 'system',
        resourceType: 'chat_room_invite',
        result: 'success',
      });
    }, WAIT);
  });

  it("voids an invite once the inviting moderator's account is closed", async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);
    await configureRoom(owner, room, { moderatorInvite: true });
    const sent = await sendInvite(moderator, room, invitee);
    await app.container
      .get(DRIZZLE)
      .db.update(chatRoomMember)
      .set({ accountClosedAt: new Date() })
      .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, moderator.userId)));

    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
    expect(await roomMemberIds(owner, room)).not.toContain(invitee.userId);
  });

  it('voids an invite once the inviter is put under a platform chat ban', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: owner.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
  });
});

describe('chat room invites: finding players', () => {
  it('matches usernames only, hides blockers and reports each status', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const tag = `pk${randomInt(10 ** 4, 10 ** 5)}`;
    const available = await registerChatter(tag);
    const member = await registerChatter(tag);
    const invited = await registerChatter(tag);
    const blocker = await registerChatter(tag);
    const emailOnly = await registerChatter('mailer', `${tag}-mail-${randomUUID()}@e2e.test`);
    await joinByCode(member, room);
    await sendInvite(owner, room, invited);
    expect((await blocker.client.post('/chat/blocks', { blockedId: owner.userId })).status).toBe(
      200,
    );

    const res = await owner.client.get(
      `/chat/rooms/${room.id}/invite-candidates?q=${tag.toUpperCase()}&limit=50`,
    );
    expect(res.status).toBe(200);
    const candidates = ChatRoomInviteCandidateSchema.array().parse(await res.json());
    const byId = new Map(candidates.map((row) => [row.userId, row.inviteStatus]));

    expect(byId.get(available.userId)).toBe('available');
    expect(byId.get(member.userId)).toBe('member');
    expect(byId.get(invited.userId)).toBe('invited');
    expect(byId.has(blocker.userId)).toBe(false);
    expect(byId.has(emailOnly.userId)).toBe(false);
    expect(byId.has(owner.userId)).toBe(false);
    expect(candidates.find((row) => row.userId === available.userId)).toMatchObject({
      username: available.username,
      avatarUrl: null,
    });
  });

  it('reports a blocker as unavailable in the status lookup', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const blocker = await registerChatter('blocker');
    const available = await registerChatter('avail');
    expect((await blocker.client.post('/chat/blocks', { blockedId: owner.userId })).status).toBe(
      200,
    );

    const res = await owner.client.post(`/chat/rooms/${room.id}/invite-statuses`, {
      userIds: [blocker.userId, available.userId, randomUUID()],
    });
    expect(res.status).toBe(200);
    const rows = ChatRoomInviteLookupSchema.array().parse(await res.json());

    expect(rows).toEqual([
      { userId: blocker.userId, inviteStatus: 'unavailable' },
      { userId: available.userId, inviteStatus: 'available' },
      { userId: expect.any(String), inviteStatus: 'unavailable' },
    ]);
  });

  it('keeps showing a member who blocked the inviter as a member', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const member = await registerChatter('member');
    await joinByCode(member, room);
    expect((await member.client.post('/chat/blocks', { blockedId: owner.userId })).status).toBe(
      200,
    );

    await expectRejected(await invite(owner, room, member.userId), 409, 'member');
    const statuses = await owner.client.post(`/chat/rooms/${room.id}/invite-statuses`, {
      userIds: [member.userId],
    });
    expect(ChatRoomInviteLookupSchema.array().parse(await statuses.json())).toEqual([
      { userId: member.userId, inviteStatus: 'member' },
    ]);
    const search = await owner.client.get(
      `/chat/rooms/${room.id}/invite-candidates?q=${member.username}`,
    );
    expect(ChatRoomInviteCandidateSchema.array().parse(await search.json())).toMatchObject([
      { userId: member.userId, inviteStatus: 'member' },
    ]);
  });

  it('reports a player under a platform chat ban as unavailable', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const banned = await registerChatter('banned');
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    const res = await owner.client.post(`/chat/rooms/${room.id}/invite-statuses`, {
      userIds: [banned.userId],
    });
    expect(ChatRoomInviteLookupSchema.array().parse(await res.json())).toEqual([
      { userId: banned.userId, inviteStatus: 'unavailable' },
    ]);
  });

  it('refuses a search shorter than three characters', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);

    const res = await owner.client.get(`/chat/rooms/${room.id}/invite-candidates?q=ab`);

    expect(res.status).toBe(400);
  });

  it('refuses the lookup to a plain member', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('member');
    const room = await createRoom(owner);
    await joinByCode(member, room);

    const res = await member.client.post(`/chat/rooms/${room.id}/invite-statuses`, {
      userIds: [owner.userId],
    });

    expect(res.status).toBe(403);
  });
});

describe('chat room invites: stored rows', () => {
  it('keeps one pending row per room and invitee', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const responses = await Promise.all([
      invite(owner, room, invitee.userId),
      invite(owner, room, invitee.userId),
      invite(owner, room, invitee.userId),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([200, 409, 409]);

    const rows = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(chatRoomInvite)
      .where(and(eq(chatRoomInvite.roomId, room.id), eq(chatRoomInvite.status, 'pending')));
    expect(rows).toHaveLength(1);
  });
});
