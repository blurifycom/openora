import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { ACCESS_REVOKED_SIGNAL, chatChannel } from '@openora/core/contracts';
import {
  CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
  ChatMessageSchema,
  ChatRoomSchema,
  ChatRoomStreamEventSchema,
  ChatSignalSchema,
  type ChatMessage,
  type ChatRoomStreamEvent,
  type ChatSignal,
} from '@openora/core/engagement/contracts/chat';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

const STREAM_PATH = '/chat/room-stream';
const PROBE = 'stream-probe';
const PROBE_ATTEMPTS = 10;
const PROBE_WAIT_MS = 500;

let db: TestDb;
let app: TestApp;
let admin: TestClient;
const openStreams: EventStream<unknown>[] = [];

type EventStream<T> = {
  response: Response;
  next: () => Promise<T | null>;
  close: () => Promise<void>;
  // Re-sends a probe until one arrives, because a payload published before the
  // server's Redis subscription is live is lost.
  waitUntilLive: (sendProbe: (attempt: number) => Promise<unknown>) => Promise<void>;
};
type RoomStream = EventStream<ChatRoomStreamEvent>;
type Request = (path: string, init?: RequestInit) => Promise<Response>;

function parseBlock(block: string): { event: string; data: string } {
  const lines = block.split('\n');
  const field = (name: string) =>
    lines
      .filter((line) => line.startsWith(`${name}:`))
      .map((line) => line.slice(name.length + 1).trimStart())
      .join('\n');
  return { event: field('event'), data: field('data') };
}

function readEventStream<T>(
  response: Response,
  controller: AbortController,
  parse: (data: unknown) => T,
  isProbe: (event: T) => boolean,
): EventStream<T> {
  const reader = response.body?.getReader();
  const queue: (T | null)[] = [];
  const waiters = new Set<() => void>();
  let probes = 0;

  const deliver = (event: T | null) => {
    if (event !== null && isProbe(event)) {
      probes += 1;
    } else {
      queue.push(event);
    }
    for (const wake of waiters) {
      wake();
    }
    waiters.clear();
  };
  const changed = (timeoutMs?: number) =>
    new Promise<void>((resolve) => {
      waiters.add(resolve);
      if (timeoutMs !== undefined) {
        setTimeout(resolve, timeoutMs);
      }
    });

  const pump = async () => {
    if (!reader) {
      deliver(null);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const { event, data } = parseBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event === 'done') {
            deliver(null);
            return;
          }
          if (event === 'message') {
            deliver(parse(JSON.parse(data)));
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          deliver(null);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      deliver(null);
    }
  };
  void pump();

  const next = async (): Promise<T | null> => {
    while (queue.length === 0) {
      await changed();
    }
    return queue.shift() ?? null;
  };
  const waitUntilLive = async (sendProbe: (attempt: number) => Promise<unknown>) => {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
      await sendProbe(attempt);
      const deadline = Date.now() + PROBE_WAIT_MS;
      while (probes === 0 && Date.now() < deadline) {
        await changed(deadline - Date.now());
      }
      if (probes > 0) {
        return;
      }
    }
    throw new Error(`stream never received a probe after ${PROBE_ATTEMPTS} attempts`);
  };
  const close = async () => {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  };
  return { response, next, close, waitUntilLive };
}

async function openEventStream<T>(
  request: Request,
  path: string,
  parse: (data: unknown) => T,
  isProbe: (event: T) => boolean,
  roomId?: string,
): Promise<EventStream<T>> {
  const controller = new AbortController();
  const query = roomId ? `?${new URLSearchParams({ roomId }).toString()}` : '';
  const response = await request(`${path}${query}`, {
    method: 'GET',
    signal: controller.signal,
  });
  const stream = readEventStream(response, controller, parse, isProbe);
  openStreams.push(stream);
  return stream;
}

function openRoomStream(request: Request, roomId?: string): Promise<RoomStream> {
  return openEventStream(
    request,
    STREAM_PATH,
    (data) => ChatRoomStreamEventSchema.parse(data),
    (event) => event.type === 'message' && event.message.content === PROBE,
    roomId,
  );
}

function openMessageStream(request: Request, roomId: string): Promise<EventStream<ChatMessage>> {
  return openEventStream(
    request,
    '/chat/stream',
    (data) => ChatMessageSchema.parse(data),
    (message) => message.content === PROBE,
    roomId,
  );
}

function openSignalStream(request: Request, roomId: string): Promise<EventStream<ChatSignal>> {
  return openEventStream(
    request,
    '/chat/signals',
    (data) => ChatSignalSchema.parse(data),
    (signal) => signal.name === CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
    roomId,
  );
}

function postProbe(sender: TestClient, roomId?: string) {
  return () =>
    sender.post(roomId ? `/chat/rooms/${roomId}/messages` : '/chat/global', { content: PROBE });
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

function accessRevoked(roomId: string | null) {
  return { name: ACCESS_REVOKED_SIGNAL, payload: { channel: chatChannel(roomId) } };
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
    await stream.waitUntilLive(postProbe(owner.client, room.id));

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
    await stream.waitUntilLive(postProbe(owner.client, room.id));

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: member.userId,
    });
    expect(removed.status).toBe(200);

    expect(await stream.next()).toEqual({ type: 'signal', signal: accessRevoked(room.id) });
    expect(await stream.next()).toBeNull();
  });

  it('cuts only the removed member, and keeps streaming to the rest', async () => {
    const owner = await registerChatter('host');
    const removedMember = await registerChatter('leaver');
    const room = await createRoomWithMember(owner.client, removedMember.client);
    const ownerStream = await openRoomStream(owner.client.request, room.id);
    const removedStream = await openRoomStream(removedMember.client.request, room.id);
    await ownerStream.waitUntilLive(postProbe(owner.client, room.id));
    await removedStream.waitUntilLive(postProbe(owner.client, room.id));

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: removedMember.userId,
    });
    expect(removed.status).toBe(200);
    expect(await removedStream.next()).toEqual({ type: 'signal', signal: accessRevoked(room.id) });
    expect(await removedStream.next()).toBeNull();

    const sent = await owner.client.post(`/chat/rooms/${room.id}/messages`, {
      content: 'still here',
    });
    expect(sent.status).toBe(200);
    expect(await ownerStream.next()).toMatchObject({
      type: 'message',
      message: { content: 'still here' },
    });
  });

  it('cuts a platform-banned player off the global chat and their private rooms', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('banned');
    const room = await createRoomWithMember(owner.client, member.client);
    const roomStream = await openRoomStream(member.client.request, room.id);
    const globalStream = await openRoomStream(member.client.request);
    await roomStream.waitUntilLive(postProbe(owner.client, room.id));
    await globalStream.waitUntilLive(postProbe(owner.client));

    const banned = await admin.post('/backoffice/chat/bans', {
      userId: member.userId,
      reason: 'e2e platform ban',
      roomId: '__all',
    });
    expect(banned.status).toBe(200);

    expect(await roomStream.next()).toEqual({ type: 'signal', signal: accessRevoked(room.id) });
    expect(await roomStream.next()).toBeNull();
    expect(await globalStream.next()).toEqual({ type: 'signal', signal: accessRevoked(null) });
    expect(await globalStream.next()).toBeNull();
    const reconnect = await openRoomStream(member.client.request, room.id);
    expect(reconnect.response.status).toBe(403);
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

describe('deprecated single-lane chat streams', () => {
  it('/chat/stream delivers plain room messages to a member', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoomWithMember(owner.client, member.client);
    const stream = await openMessageStream(member.client.request, room.id);
    expect(stream.response.status).toBe(200);
    await stream.waitUntilLive(postProbe(owner.client, room.id));

    const sent = await owner.client.post(`/chat/rooms/${room.id}/messages`, {
      content: 'legacy hello',
    });
    expect(sent.status).toBe(200);

    expect(await stream.next()).toMatchObject({ roomId: room.id, content: 'legacy hello' });
  });

  it('/chat/stream ends a removed member stream and refuses the reconnect', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('leaver');
    const room = await createRoomWithMember(owner.client, member.client);
    const stream = await openMessageStream(member.client.request, room.id);
    await stream.waitUntilLive(postProbe(owner.client, room.id));

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: member.userId,
    });
    expect(removed.status).toBe(200);

    expect(await stream.next()).toBeNull();
    const reconnect = await openMessageStream(member.client.request, room.id);
    expect(reconnect.response.status).toBe(403);
  });

  it('/chat/signals delivers access-revoked to a removed member, ends, and refuses the reconnect', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('leaver');
    const room = await createRoomWithMember(owner.client, member.client);
    const stream = await openSignalStream(member.client.request, room.id);
    await stream.waitUntilLive((attempt) =>
      owner.client.post(`/chat/rooms/${room.id}/members/${member.userId}/role`, {
        role: attempt % 2 === 0 ? 'moderator' : 'member',
      }),
    );

    const removed = await owner.client.post(`/chat/rooms/${room.id}/remove`, {
      userId: member.userId,
    });
    expect(removed.status).toBe(200);

    expect(await stream.next()).toEqual(accessRevoked(room.id));
    expect(await stream.next()).toBeNull();
    const reconnect = await openSignalStream(member.client.request, room.id);
    expect(reconnect.response.status).toBe(403);
  });
});
