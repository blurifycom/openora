import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { ACCESS_REVOKED_SIGNAL, chatChannel } from '@openora/core/contracts';
import {
  CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
  ChatRoomSchema,
  ChatRoomStreamEventSchema,
  type ChatRoomStreamEvent,
} from '@openora/core/engagement/contracts/chat';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

const SUBSCRIBE_SETTLE_MS = 300;
const STREAM_PATH = '/chat/room-stream';

let db: TestDb;
let app: TestApp;
const openStreams: RoomStream[] = [];

type RoomStream = {
  response: Response;
  next: () => Promise<ChatRoomStreamEvent | null>;
  close: () => Promise<void>;
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
}

function parseBlock(block: string): { event: string; data: string } {
  const lines = block.split('\n');
  const field = (name: string) =>
    lines
      .filter((line) => line.startsWith(`${name}:`))
      .map((line) => line.slice(name.length + 1).trimStart())
      .join('\n');
  return { event: field('event'), data: field('data') };
}

function readRoomStream(response: Response, controller: AbortController): RoomStream {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<ChatRoomStreamEvent | null> => {
    if (!reader) {
      return null;
    }
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const { event, data } = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event === 'done') {
          return null;
        }
        if (event === 'message') {
          return ChatRoomStreamEventSchema.parse(JSON.parse(data));
        }
        continue;
      }
      const { value, done } = await reader.read();
      if (done) {
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const close = async () => {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  };
  return { response, next, close };
}

async function openRoomStream(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  roomId?: string,
): Promise<RoomStream> {
  const controller = new AbortController();
  const query = roomId ? `?${new URLSearchParams({ roomId }).toString()}` : '';
  const response = await request(`${STREAM_PATH}${query}`, {
    method: 'GET',
    signal: controller.signal,
  });
  const stream = readRoomStream(response, controller);
  openStreams.push(stream);
  return stream;
}

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
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(openStreams.map((stream) => stream.close()));
  await app?.close();
  await db?.dispose();
});

describe('chat room stream: both lanes of a room on one connection', () => {
  it('delivers a member the room messages and signals, each tagged by lane', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const stream = await openRoomStream(member.client.request, room.id);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    await settle();

    const sent = await owner.client.post(`/chat/rooms/${room.id}/messages`, { content: 'hello' });
    expect(sent.status).toBe(200);
    const message = await stream.next();
    expect(message).toMatchObject({
      type: 'message',
      message: { roomId: room.id, userId: owner.userId, content: 'hello' },
    });

    const promoted = await owner.client.post(
      `/chat/rooms/${room.id}/members/${member.userId}/role`,
      { role: 'moderator' },
    );
    expect(promoted.status).toBe(200);
    expect(await stream.next()).toEqual({
      type: 'signal',
      signal: {
        name: CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
        payload: { roomId: room.id, userId: member.userId, role: 'moderator' },
      },
    });
  });

  it('delivers access-revoked to a removed member and then ends their stream', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('leaver');
    const room = await createRoomWithMember(owner.client, member.client);

    const stream = await openRoomStream(member.client.request, room.id);
    expect(stream.response.status).toBe(200);
    await settle();

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: member.userId,
    });
    expect(removed.status).toBe(200);

    expect(await stream.next()).toEqual({
      type: 'signal',
      signal: { name: ACCESS_REVOKED_SIGNAL, payload: { channel: chatChannel(room.id) } },
    });
    expect(await stream.next()).toBeNull();
  });

  it('keeps streaming to the remaining members after one is removed', async () => {
    const owner = await registerChatter('host');
    const removedMember = await registerChatter('leaver');
    const room = await createRoomWithMember(owner.client, removedMember.client);
    const ownerStream = await openRoomStream(owner.client.request, room.id);
    await settle();

    await owner.client.post(`/chat/rooms/${room.id}/remove`, { userId: removedMember.userId });
    await owner.client.post(`/chat/rooms/${room.id}/messages`, { content: 'still here' });

    expect(await ownerStream.next()).toMatchObject({
      type: 'message',
      message: { content: 'still here' },
    });
  });

  it('refuses a private room stream to a player who is not a member', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const outsider = await registerChatter('visitor');
    const room = await createRoomWithMember(owner.client, member.client);

    const stream = await openRoomStream(outsider.client.request, room.id);

    expect(stream.response.status).toBe(403);
  });

  it('refuses a private room stream to an anonymous viewer', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);

    const stream = await openRoomStream(async (path, init) => app.app.request(path, init), room.id);

    expect(stream.response.status).toBe(403);
  });

  it('opens the global stream for an anonymous viewer', async () => {
    const stream = await openRoomStream(async (path, init) => app.app.request(path, init));

    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
  });
});
