import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { ChatMessageSchema, ChatRoomSchema } from '@openora/core/engagement/contracts/chat';
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
