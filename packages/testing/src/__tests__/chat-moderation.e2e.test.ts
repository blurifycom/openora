import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { adminRole, adminRolePermission, adminRoleAssignment } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import {
  ChatMessageSchema,
  ChatModerationEntrySchema,
  ChatPlatformBanSchema,
  ChatRoomSchema,
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
let globalRoomId: string;

async function registerChatter(prefix: string) {
  const username = `${prefix.slice(0, 7)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  return registerAndMaterializePlayer(app, { email: `${username}@e2e.test`, username });
}

async function registerChatViewer() {
  const viewer = await registerChatter('viewer');
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, viewer.userId));
  const [role] = await drizzle
    .insert(adminRole)
    .values({ name: `chat viewer ${randomUUID()}` })
    .returning({ id: adminRole.id });
  await drizzle
    .insert(adminRolePermission)
    .values({ roleId: role!.id, resource: 'chat-room', level: 'read' });
  await drizzle.insert(adminRoleAssignment).values({ userId: viewer.userId, roleId: role!.id });
  return viewer;
}

async function createRoomWithMember(owner: TestClient, member: TestClient) {
  const created = await owner.post('/chat/rooms/private', { name: `room-${randomUUID()}` });
  expect(created.status).toBe(200);
  const room = ChatRoomSchema.parse(await created.json());
  const joined = await member.post('/chat/rooms/join', { joinCode: room.joinCode });
  expect(joined.status).toBe(200);
  return room;
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
  const rooms = ChatRoomSchema.array().parse(await (await app.app.request('/chat/rooms')).json());
  const globalRoom = rooms.find((room) => room.slug === GLOBAL_CHAT_ROOM_ID);
  if (!globalRoom) {
    throw new Error('global chat room is not seeded');
  }
  globalRoomId = globalRoom.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('chat: the global room under its row id', () => {
  it('stores a message sent to the global room id as a global message', async () => {
    const sender = await registerChatter('global');

    const sent = await sender.client.post(`/chat/rooms/${globalRoomId}/messages`, {
      content: 'hello everyone',
    });

    expect(sent.status).toBe(200);
    expect(ChatMessageSchema.parse(await sent.json()).roomId).toBeNull();
    const global = ChatMessageSchema.array().parse(
      await (await app.app.request('/chat/global')).json(),
    );
    expect(global.map((message) => message.content)).toContain('hello everyone');
  });

  it('refuses a globally banned player who sends to the global room id', async () => {
    const banned = await registerChatter('banned');
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    const sent = await banned.client.post(`/chat/rooms/${globalRoomId}/messages`, {
      content: 'still here',
    });

    expect(sent.status).toBe(403);
  });

  it('applies a ban issued by the global room id to the global chat', async () => {
    const banned = await registerChatter('banned');
    const ban = await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: globalRoomId,
      reason: 'spam',
    });
    expect(ban.status).toBe(200);

    const sent = await banned.client.post('/chat/global', { content: 'still here' });

    expect(sent.status).toBe(403);
  });
});

describe('chat: the global room in the back office', () => {
  it('lists a message sent to the global room id under that id', async () => {
    const sender = await registerChatter('global');
    const content = `seen-${randomUUID()}`;
    const sent = await sender.client.post(`/chat/rooms/${globalRoomId}/messages`, { content });
    expect(sent.status).toBe(200);

    const listed = await admin.get(`/backoffice/chat/rooms/${globalRoomId}/messages?limit=100`);
    const searched = await admin.get(
      `/backoffice/chat/messages?roomId=${globalRoomId}&search=${content}`,
    );

    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: { content: string }[] };
    expect(items.map((message) => message.content)).toContain(content);
    const found = (await searched.json()) as { items: { content: string }[] };
    expect(found.items.map((message) => message.content)).toEqual([content]);
  });
});

describe('chat: back-office room join', () => {
  it('lets an admin join a private room', async () => {
    const owner = await registerChatter('host');
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    const room = ChatRoomSchema.parse(await created.json());

    const joined = await admin.post(`/backoffice/chat/rooms/${room.id}/join`);

    expect(joined.status).toBe(200);
  });

  it('refuses an admin who can only view chat rooms', async () => {
    const owner = await registerChatter('host');
    const viewer = await registerChatViewer();
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    const room = ChatRoomSchema.parse(await created.json());
    expect((await viewer.client.get('/backoffice/chat/rooms')).status).toBe(200);

    const joined = await viewer.client.post(`/backoffice/chat/rooms/${room.id}/join`);

    expect(joined.status).toBe(403);
  });
});

describe('chat: platform bans', () => {
  it('replaces an active ban when the player is banned again', async () => {
    const player = await registerChatter('escal');
    await admin.post('/backoffice/chat/bans', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'first',
      durationSeconds: 60,
    });

    const again = await admin.post('/backoffice/chat/bans', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'escalated',
      durationSeconds: null,
    });

    expect(again.status).toBe(200);
    const bans = (await (
      await admin.get(`/backoffice/chat/bans?userId=${player.userId}`)
    ).json()) as { reason: string; bannedUntil: string | null }[];
    expect(bans).toEqual([expect.objectContaining({ reason: 'escalated', bannedUntil: null })]);
  });

  it('refuses a ban from a player without the moderation permission', async () => {
    const player = await registerChatter('rogue');
    const target = await registerChatter('target');

    const ban = await player.client.post('/backoffice/chat/bans', {
      userId: target.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'spam',
    });

    expect(ban.status).toBe(403);
  });
});

describe('chat: room configuration', () => {
  it('refuses to let a player join a locked room by its join code', async () => {
    const owner = await registerChatter('host');
    const latecomer = await registerChatter('late');
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    const room = ChatRoomSchema.parse(await created.json());
    const locked = await owner.client.patch(`/chat/rooms/${room.id}/configuration`, {
      lockRoom: true,
    });
    expect(locked.status).toBe(200);

    const joined = await latecomer.client.post('/chat/rooms/join', { joinCode: room.joinCode });

    expect(joined.status).toBe(403);
  });

  it('holds a member to slow mode and lets the owner post freely', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    const slowed = await owner.client.patch(`/chat/rooms/${room.id}/configuration`, {
      slowMode: true,
      slowModeSeconds: 60,
    });
    expect(slowed.status).toBe(200);

    const send = (client: TestClient, content: string) =>
      client.post(`/chat/rooms/${room.id}/messages`, { content });

    expect((await send(member.client, 'first')).status).toBe(200);
    expect((await send(member.client, 'second')).status).toBe(403);
    expect((await send(owner.client, 'first')).status).toBe(200);
    expect((await send(owner.client, 'second')).status).toBe(200);
  });

  it('refuses a configuration change from a member who is not a moderator', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const changed = await member.client.patch(`/chat/rooms/${room.id}/configuration`, {
      lockRoom: true,
    });

    expect(changed.status).toBe(403);
  });
});

describe('chat: leaving a room', () => {
  it('lets a member leave a room they are in', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const left = await member.client.post(`/chat/rooms/${room.id}/leave`);

    expect(left.status).toBe(200);
  });

  it('refuses a player who is not a member of the private room', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const outsider = await registerChatter('visitor');
    const room = await createRoomWithMember(owner.client, member.client);

    const left = await outsider.client.post(`/chat/rooms/${room.id}/leave`);

    expect(left.status).toBe(403);
  });

  it('refuses the owner, who must hand the room over or delete it', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const left = await owner.client.post(`/chat/rooms/${room.id}/leave`);

    expect(left.status).toBe(400);
  });

  it('answers not found for a deleted room', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    expect((await owner.client.del(`/chat/rooms/${room.id}`)).status).toBe(200);

    const left = await member.client.post(`/chat/rooms/${room.id}/leave`);

    expect(left.status).toBe(404);
  });
});

describe('chat: message history', () => {
  it('rejects a cursor that is not a timestamp', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const page = await member.client.get(`/chat/rooms/${room.id}/messages?before=yesterday`);

    expect(page.status).toBe(400);
  });
});

async function auditRows(action: string, resourceId: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

describe('chat: room bans and mutes by a room moderator', () => {
  it('replaces a room ban and records the ban it replaced', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    const ban = (body: Record<string, unknown>) =>
      owner.client.post(`/chat/rooms/${room.id}/ban`, { userId: member.userId, ...body });

    expect((await ban({ reason: 'first' })).status).toBe(200);
    expect((await ban({ reason: 'shortened', durationSeconds: 60 })).status).toBe(200);

    // The room-ban audit row is written from the event after commit.
    await expect
      .poll(async () =>
        (await auditRows('chat.room.member.banned', member.userId)).map((row) => row.before),
      )
      .toContainEqual(expect.objectContaining({ expiresAt: null }));
    expect((await member.client.post('/chat/rooms/join', { joinCode: room.joinCode })).status).toBe(
      403,
    );
  });

  it('refuses a room ban from a member who is not a moderator', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const ban = await member.client.post(`/chat/rooms/${room.id}/ban`, {
      userId: owner.userId,
      reason: 'coup',
    });

    expect(ban.status).toBe(403);
  });

  it('mutes a member in the room and lifts it again', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    const send = () => member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'hi' });

    expect(
      (
        await owner.client.post(`/chat/rooms/${room.id}/mute`, {
          userId: member.userId,
          reason: 'noise',
        })
      ).status,
    ).toBe(200);
    expect((await send()).status).toBe(403);
    expect(
      (await owner.client.post(`/chat/rooms/${room.id}/mute/lift`, { userId: member.userId }))
        .status,
    ).toBe(200);

    expect((await send()).status).toBe(200);
  });

  it('refuses a moderator muting themselves with 400', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const muted = await owner.client.post(`/chat/rooms/${room.id}/mute`, {
      userId: owner.userId,
      reason: 'self',
    });

    expect(muted.status).toBe(400);
  });
});

describe('chat: back-office mutes and lifts', () => {
  it('mutes a player in global chat and lifts it', async () => {
    const player = await registerChatter('loud');
    const send = () => player.client.post('/chat/global', { content: 'hello' });
    const muted = await admin.post('/backoffice/chat/mutes', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'noise',
    });
    expect(muted.status).toBe(200);
    expect((await send()).status).toBe(403);

    const lifted = await admin.post('/backoffice/chat/mutes/lift', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
    });

    expect(lifted.status).toBe(200);
    expect((await send()).status).toBe(200);
  });

  it('lifts a platform ban', async () => {
    const player = await registerChatter('banned');
    await admin.post('/backoffice/chat/bans', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'spam',
    });

    const lifted = await admin.post('/backoffice/chat/bans/lift', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
    });

    expect(lifted.status).toBe(200);
    expect((await player.client.post('/chat/global', { content: 'back' })).status).toBe(200);
  });

  it('refuses a mute or a lift from a player', async () => {
    const player = await registerChatter('rogue');
    const target = await registerChatter('target');
    const body = { userId: target.userId, roomId: GLOBAL_CHAT_ROOM_ID, reason: 'x' };

    expect((await player.client.post('/backoffice/chat/mutes', body)).status).toBe(403);
    expect((await player.client.post('/backoffice/chat/mutes/lift', body)).status).toBe(403);
    expect((await player.client.post('/backoffice/chat/bans/lift', body)).status).toBe(403);
  });
});

describe('chat: back-office moderation lookups by user ids', () => {
  const userIdsQuery = (userIds: readonly string[]) =>
    userIds.map((id) => `userIds[]=${id}`).join('&');

  it('lists only the active mutes and bans of the requested users', async () => {
    const first = await registerChatter('first');
    const second = await registerChatter('second');
    const other = await registerChatter('other');
    for (const { userId } of [first, second, other]) {
      const body = { userId, roomId: GLOBAL_CHAT_ROOM_ID, reason: 'lookup' };
      expect((await admin.post('/backoffice/chat/mutes', body)).status).toBe(200);
      expect((await admin.post('/backoffice/chat/bans', body)).status).toBe(200);
    }
    const requested = [first.userId, second.userId];
    const query = userIdsQuery(requested);

    const mutes = await admin.get(`/backoffice/chat/mutes?${query}`);
    const bans = await admin.get(`/backoffice/chat/bans?${query}`);

    expect(mutes.status).toBe(200);
    expect(bans.status).toBe(200);
    const mutedUsers = ChatModerationEntrySchema.array()
      .parse(await mutes.json())
      .map((entry) => entry.userId);
    const bannedUsers = ChatPlatformBanSchema.array()
      .parse(await bans.json())
      .map((entry) => entry.userId);
    for (const listed of [mutedUsers, bannedUsers]) {
      expect(listed).toHaveLength(requested.length);
      expect(listed).toEqual(expect.arrayContaining(requested));
      expect(listed).not.toContain(other.userId);
    }
  });

  it('refuses userId together with userIds', async () => {
    const player = await registerChatter('both');
    const query = `userId=${player.userId}&${userIdsQuery([player.userId])}`;

    expect((await admin.get(`/backoffice/chat/mutes?${query}`)).status).toBe(400);
    expect((await admin.get(`/backoffice/chat/bans?${query}`)).status).toBe(400);
  });

  it('refuses more than 100 user ids', async () => {
    const query = userIdsQuery(Array.from({ length: 101 }, () => randomUUID()));

    expect((await admin.get(`/backoffice/chat/mutes?${query}`)).status).toBe(400);
    expect((await admin.get(`/backoffice/chat/bans?${query}`)).status).toBe(400);
  });
});

describe('chat: room rules', () => {
  it('creates, edits and deletes a rule, auditing each change', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    const created = await owner.client.post(`/chat/rooms/${room.id}/rules`, {
      content: 'Be kind',
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    expect(
      (await owner.client.patch(`/chat/rooms/${room.id}/rules/${id}`, { content: 'Be kinder' }))
        .status,
    ).toBe(200);
    expect((await owner.client.del(`/chat/rooms/${room.id}/rules/${id}`)).status).toBe(200);

    expect(await auditRows('chat.room.rule.created', id)).toHaveLength(1);
    expect(await auditRows('chat.room.rule.updated', id)).toHaveLength(1);
    expect(await auditRows('chat.room.rule.deleted', id)).toHaveLength(1);
  });

  it('refuses a rule from a member and a rule over the length cap', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const fromMember = await member.client.post(`/chat/rooms/${room.id}/rules`, {
      content: 'Mine',
    });
    const tooLong = await owner.client.post(`/chat/rooms/${room.id}/rules`, {
      content: 'x'.repeat(1001),
    });

    expect(fromMember.status).toBe(403);
    expect(tooLong.status).toBe(400);
  });
});

describe('chat: connection grant', () => {
  it('grants a connection with a client id and refuses an oversized one', async () => {
    const player = await registerChatter('conn');

    const granted = await player.client.get('/chat/connection?clientId=tab-1');
    const oversized = await player.client.get(`/chat/connection?clientId=${'x'.repeat(129)}`);

    expect(granted.status).toBe(200);
    expect(oversized.status).toBe(400);
  });
});

describe('chat: online count', () => {
  it('counts the global room under its row id and refuses a banned player', async () => {
    const player = await registerChatter('count');
    const banned = await registerChatter('banned');
    await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'spam',
    });

    const counted = await player.client.get(`/chat/online-count?roomId=${globalRoomId}`);
    const refused = await banned.client.get(`/chat/online-count?roomId=${globalRoomId}`);

    expect(counted.status).toBe(200);
    expect(refused.status).toBe(403);
  });

  it('answers 403, not 500, when a banned player reads the global room by its row id', async () => {
    const banned = await registerChatter('banned');
    await admin.post('/backoffice/chat/bans', {
      userId: banned.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      reason: 'spam',
    });

    for (const path of ['', '/configuration', '/members']) {
      expect((await banned.client.get(`/chat/rooms/${globalRoomId}${path}`)).status).toBe(403);
    }
  });
});

describe('chat: locked public room', () => {
  it('refuses a newcomer but lets a member join again', async () => {
    const regular = await registerChatter('regular');
    const newcomer = await registerChatter('late');
    const created = await admin.post('/backoffice/chat/rooms', {
      name: `public-${randomUUID()}`,
      slug: `public-${randomUUID()}`,
      category: 'games-sports',
    });
    expect(created.status).toBe(200);
    const room = ChatRoomSchema.parse(await created.json());
    expect((await regular.client.post(`/chat/rooms/${room.id}/join`)).status).toBe(200);
    const locked = await admin.patch(`/chat/rooms/${room.id}/configuration`, { lockRoom: true });
    expect(locked.status).toBe(200);

    const refused = await newcomer.client.post(`/chat/rooms/${room.id}/join`);
    const rejoined = await regular.client.post(`/chat/rooms/${room.id}/join`);

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { data?: { reason?: string } }).data?.reason).toBe('locked');
    expect(rejoined.status).toBe(200);
  });
});

describe('chat: message history cursor', () => {
  it('pages older messages with an offset timestamp cursor', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    await owner.client.post(`/chat/rooms/${room.id}/messages`, { content: 'older' });

    const page = await member.client.get(
      `/chat/rooms/${room.id}/messages?before=${encodeURIComponent('2999-01-01T00:00:00+02:00')}`,
    );

    expect(page.status).toBe(200);
    const messages = ChatMessageSchema.array().parse(await page.json());
    expect(messages.map((message) => message.content)).toContain('older');
  });
});
