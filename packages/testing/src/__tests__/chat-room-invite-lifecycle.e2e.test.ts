import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { JOB_QUEUE, PLAY_ELIGIBILITY, queue } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { chatRoomConfiguration, chatRoomInvite } from '@openora/core/engagement/schema/chat';
import {
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
let adminUserId: string;

const WAIT = { timeout: 10_000, interval: 100 };

type Chatter = Awaited<ReturnType<typeof registerAndMaterializePlayer>> & { username: string };

async function registerChatter(prefix: string): Promise<Chatter> {
  const username = `${prefix.slice(0, 7)}_${randomInt(10 ** 9, 10 ** 10)}`;
  const registered = await registerAndMaterializePlayer(app, {
    email: `${username}@e2e.test`,
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
  values: { moderatorInvite?: boolean; onlyInvitedCanJoin?: boolean },
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

async function auditRows(resourceId: string, action: string, actorId?: string) {
  const res = await admin.get(
    `/audit/logs?resourceId=${resourceId}&action=${action}${actorId ? `&actorId=${actorId}` : ''}`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items;
}

async function expectExpiredBy(inviteId: string, actorType: 'player' | 'admin', actorId: string) {
  await vi.waitFor(async () => {
    expect(await inviteRow(inviteId)).toMatchObject({ status: 'expired', respondedAt: null });
  }, WAIT);
  await vi.waitFor(async () => {
    expect(await auditRows(inviteId, 'chat.room.invite.expired')).toMatchObject([
      { actorType, actorId, resourceType: 'chat_room_invite', result: 'success' },
    ]);
  }, WAIT);
}

async function inviteFromModerator(owner: Chatter, room: ChatRoom, invitee: Chatter) {
  const moderator = await addModerator(owner, room);
  await configureRoom(owner, room, { moderatorInvite: true });
  return { moderator, sent: await sendInvite(moderator, room, invitee) };
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
  const [staff] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  if (!staff) {
    throw new Error('the seeded admin is missing');
  }
  adminUserId = staff.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('chat room invites: expiry in storage', () => {
  it("expires a demoted moderator's invite for good", async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);
    await configureRoom(owner, room, { moderatorInvite: true });
    const sent = await sendInvite(moderator, room, invitee);

    const setRole = (role: 'member' | 'moderator') =>
      owner.client.post(`/chat/rooms/${room.id}/members/${moderator.userId}/role`, { role });
    expect((await setRole('member')).status).toBe(200);
    expect(await inviteRow(sent.id)).toMatchObject({ status: 'expired', respondedAt: null });
    expect((await setRole('moderator')).status).toBe(200);

    expect(await inviteRow(sent.id)).toMatchObject({ status: 'expired' });
    expect(await myInvites(invitee)).toEqual([]);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
    await expectExpiredBy(sent.id, 'player', owner.playerId);
  });

  it('sweeps an invite older than seven days into storage as expired', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const stale = await sendInvite(owner, room, invitee);
    const fresh = await sendInvite(owner, room, await registerChatter('guest'));
    await app.container
      .get(DRIZZLE)
      .db.update(chatRoomInvite)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(chatRoomInvite.id, stale.id));

    await app.container.get(JOB_QUEUE).enqueue(queue('chat-room-invite-expiry'), {});

    await vi.waitFor(async () => {
      expect(await inviteRow(stale.id)).toMatchObject({ status: 'expired', respondedAt: null });
    }, WAIT);
    expect(await inviteRow(fresh.id)).toMatchObject({ status: 'pending' });
    await vi.waitFor(async () => {
      expect(await auditRows(stale.id, 'chat.room.invite.expired')).toMatchObject([
        { actorType: 'system', resourceType: 'chat_room_invite', result: 'success' },
      ]);
    }, WAIT);
  });
});

describe('chat room invites: expiry when a party leaves the room', () => {
  it("expires a moderator's invite when they leave the room", async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const { moderator, sent } = await inviteFromModerator(
      owner,
      room,
      await registerChatter('guest'),
    );

    expect((await moderator.client.post(`/chat/rooms/${room.id}/leave`)).status).toBe(200);

    await expectExpiredBy(sent.id, 'player', moderator.playerId);
  });

  it("expires a moderator's invite when the owner removes them", async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const { moderator, sent } = await inviteFromModerator(
      owner,
      room,
      await registerChatter('guest'),
    );

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: moderator.userId,
    });
    expect(removed.status).toBe(200);

    await expectExpiredBy(sent.id, 'player', owner.playerId);
  });

  it("expires a moderator's invite when the owner bans them from the room", async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const { moderator, sent } = await inviteFromModerator(
      owner,
      room,
      await registerChatter('guest'),
    );

    const banned = await owner.client.post(`/chat/rooms/${room.id}/ban`, {
      userId: moderator.userId,
    });
    expect(banned.status).toBe(200);

    await expectExpiredBy(sent.id, 'player', owner.playerId);
  });

  it("expires a moderator's invite once their account is closed", async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const { moderator, sent } = await inviteFromModerator(owner, room, invitee);

    expect((await admin.del(`/players/${moderator.playerId}`)).status).toBe(200);

    await expectExpiredBy(sent.id, 'player', moderator.playerId);
    expect(await myInvites(invitee)).toEqual([]);
  });

  it("expires an invite once its invitee's account is closed", async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    expect((await admin.del(`/players/${invitee.playerId}`)).status).toBe(200);

    await expectExpiredBy(sent.id, 'player', invitee.playerId);
  });

  it('expires an invite when its invitee is banned from the room', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    const banned = await owner.client.post(`/chat/rooms/${room.id}/ban`, {
      userId: invitee.userId,
    });
    expect(banned.status).toBe(200);

    await expectExpiredBy(sent.id, 'player', owner.playerId);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
  });

  it('expires an invite when its invitee gets a platform chat ban', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    const banned = await admin.post('/backoffice/chat/bans', {
      userId: invitee.userId,
      roomId: '__all',
      reason: 'spam',
    });
    expect(banned.status).toBe(200);

    await expectExpiredBy(sent.id, 'admin', adminUserId);
  });

  it('expires pending invites when the owner deletes the room', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, await registerChatter('guest'));

    expect((await owner.client.del(`/chat/rooms/${room.id}`)).status).toBe(200);

    await expectExpiredBy(sent.id, 'player', owner.playerId);
  });

  it('expires pending invites when staff delete the room', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, await registerChatter('guest'));

    expect((await admin.del(`/backoffice/chat/rooms/${room.id}`)).status).toBe(200);

    await expectExpiredBy(sent.id, 'admin', adminUserId);
  });
});

describe('chat room invites: eligibility after the invite', () => {
  it('hides an invite once the invitee is self-excluded or restricted', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const selfExcluded = await registerChatter('excluded');
    const restricted = await registerChatter('resting');
    const toExcluded = await sendInvite(owner, room, selfExcluded);
    const toRestricted = await sendInvite(owner, room, restricted);
    expect((await myInvites(selfExcluded)).map((row) => row.id)).toEqual([toExcluded.id]);
    expect((await myInvites(restricted)).map((row) => row.id)).toEqual([toRestricted.id]);

    const drizzle = app.container.get(DRIZZLE).db;
    await drizzle
      .update(player)
      .set({ status: 'self_excluded' })
      .where(eq(player.userId, selfExcluded.userId));
    await drizzle.update(user).set({ rgBlocked: true }).where(eq(user.id, restricted.userId));
    expect(await app.container.get(PLAY_ELIGIBILITY).isRestricted(restricted.userId)).toBe(true);

    for (const [invitee, sent] of [
      [selfExcluded, toExcluded],
      [restricted, toRestricted],
    ] as const) {
      expect(await myInvites(invitee)).toEqual([]);
      expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(404);
      expect(await roomMemberIds(owner, room)).not.toContain(invitee.userId);
      expect(await inviteRow(sent.id)).toMatchObject({ status: 'pending' });
    }
  });
});

describe('chat room invites: room settings', () => {
  it('admits an invite-only room by invite and by staff, but not by code', async () => {
    const owner = await registerChatter('host');
    const stranger = await registerChatter('stranger');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    await configureRoom(owner, room, { onlyInvitedCanJoin: true });

    await expectRejected(
      await stranger.client.post('/chat/rooms/join', { joinCode: room.joinCode }),
      403,
      'invite_only',
    );
    const sent = await sendInvite(owner, room, invitee);
    expect((await invitee.client.post(`/chat/invites/${sent.id}/accept`)).status).toBe(200);
    expect((await admin.post(`/backoffice/chat/rooms/${room.id}/join`)).status).toBe(200);

    const members = await roomMemberIds(owner, room);
    expect(members).toContain(invitee.userId);
    expect(members).not.toContain(stranger.userId);
  });

  it('lets anyone join a public room that has invite-only switched on', async () => {
    const created = await admin.post('/backoffice/chat/rooms', {
      name: `public-${randomUUID()}`,
      slug: `public-${randomUUID()}`,
      category: 'games-sports',
    });
    expect(created.status).toBe(200);
    const room = ChatRoomSchema.parse(await created.json());
    await app.container
      .get(DRIZZLE)
      .db.update(chatRoomConfiguration)
      .set({ onlyInvitedCanJoin: true })
      .where(eq(chatRoomConfiguration.roomId, room.id));
    const newcomer = await registerChatter('newcomer');

    expect((await newcomer.client.post(`/chat/rooms/${room.id}/join`)).status).toBe(200);
  });

  it("audits a moderator's refused change to whether moderators may invite", async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);

    const refused = await moderator.client.patch(`/chat/rooms/${room.id}/configuration`, {
      moderatorInvite: true,
    });

    expect(refused.status).toBe(403);
    await vi.waitFor(async () => {
      expect(
        await auditRows(
          'chat.room_configuration:update',
          'identity.user.unauthorized_access',
          moderator.playerId,
        ),
      ).toMatchObject([
        {
          actorType: 'player',
          actorId: moderator.playerId,
          resourceType: 'chat.room_configuration',
          result: 'failure',
        },
      ]);
    }, WAIT);
  });

  it('lets only the owner change whether moderators may invite', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const moderator = await addModerator(owner, room);
    const patch = (actor: Chatter, values: Record<string, boolean>) =>
      actor.client.patch(`/chat/rooms/${room.id}/configuration`, values);

    expect((await patch(moderator, { moderatorInvite: true })).status).toBe(403);
    expect((await patch(moderator, { moderatorInvite: false })).status).toBe(200);
    expect((await patch(owner, { moderatorInvite: true })).status).toBe(200);
    expect((await patch(moderator, { moderatorInvite: true })).status).toBe(200);
    expect((await patch(moderator, { moderatorInvite: false })).status).toBe(403);
  });
});

describe('chat room invites: concurrency', () => {
  it('completes concurrent invites into one room', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const invitees = await Promise.all(Array.from({ length: 12 }, () => registerChatter('crowd')));

    const responses = await Promise.all(
      invitees.map((invitee) => invite(owner, room, invitee.userId)),
    );

    expect(responses.map((res) => res.status)).toEqual(invitees.map(() => 200));
  });

  it('answers two concurrent accepts with the same room and accepts once', async () => {
    const owner = await registerChatter('host');
    const invitee = await registerChatter('guest');
    const room = await createRoom(owner);
    const sent = await sendInvite(owner, room, invitee);

    const responses = await Promise.all([
      invitee.client.post(`/chat/invites/${sent.id}/accept`),
      invitee.client.post(`/chat/invites/${sent.id}/accept`),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    const rooms = await Promise.all(
      responses.map(async (res) => ChatRoomSchema.parse(await res.json()).id),
    );
    expect(rooms).toEqual([room.id, room.id]);
    await vi.waitFor(async () => {
      expect(await auditRows(sent.id, 'chat.room.invite.accepted')).toHaveLength(1);
    }, WAIT);
    expect(await auditRows(sent.id, 'chat.room.invite.accepted')).toHaveLength(1);
  });
});
