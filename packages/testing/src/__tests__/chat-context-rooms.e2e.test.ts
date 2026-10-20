import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, like, or, sql, and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  CHAT_CONTEXT_ROOMS,
  CHAT_SYSTEM_AUTHOR_ID,
  CHAT_SYSTEM_WRITER,
  chatChannel,
} from '@openora/core/contracts';
import {
  ChatConnectionGrantSchema,
  ChatMessageSchema,
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
  uniqueUsername,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

async function registerChatter(prefix: string) {
  const username = uniqueUsername(prefix);
  return registerAndMaterializePlayer(app, { email: `${username}@e2e.test`, username });
}

async function contextRoomFor(...memberIds: string[]) {
  const ref = `ctx:${randomUUID()}`;
  const { room } = await app.container
    .get(CHAT_CONTEXT_ROOMS)
    .ensureRoom({ ref, name: 'Context', memberIds });
  return { ref, room };
}

async function contextRoomAudit(roomId: string) {
  return app.container
    .get(DRIZZLE)
    .db.select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(
      and(
        like(auditLog.action, 'chat.context_room.%'),
        or(
          eq(auditLog.resourceId, roomId),
          sql`${auditLog.after}->>'roomId' = ${roomId}`,
          sql`${auditLog.before}->>'roomId' = ${roomId}`,
        ),
      ),
    )
    .orderBy(asc(auditLog.seq));
}

async function openStream(client: TestClient, roomId: string) {
  const controller = new AbortController();
  const response = await client.request(`/chat/room-stream?roomId=${roomId}`, {
    method: 'GET',
    signal: controller.signal,
  });
  controller.abort();
  return response.status;
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

describe('chat: context rooms', () => {
  it('lets a member read, stream and post without listing the room', async () => {
    const member = await registerChatter('member');
    const { room } = await contextRoomFor(member.userId);

    const sent = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'gl' });
    const history = await member.client.get(`/chat/rooms/${room.id}/messages`);
    const rooms = await member.client.get('/chat/rooms');
    const connection = await member.client.get('/chat/connection');

    expect(sent.status).toBe(200);
    expect(history.status).toBe(200);
    expect(
      ChatMessageSchema.array()
        .parse(await history.json())
        .map((m) => m.content),
    ).toEqual(['gl']);
    expect(await openStream(member.client, room.id)).toBe(200);
    expect(
      ChatRoomSchema.array()
        .parse(await rooms.json())
        .map((r) => r.id),
    ).not.toContain(room.id);
    expect(ChatConnectionGrantSchema.parse(await connection.json()).channels).not.toContain(
      chatChannel(room.id),
    );
  });

  it('refuses a player who is not a member', async () => {
    const member = await registerChatter('member');
    const outsider = await registerChatter('outsider');
    const { room } = await contextRoomFor(member.userId);

    const history = await outsider.client.get(`/chat/rooms/${room.id}/messages`);
    const sent = await outsider.client.post(`/chat/rooms/${room.id}/messages`, { content: 'hi' });
    const left = await member.client.post(`/chat/rooms/${room.id}/leave`);

    expect(history.status).toBe(403);
    expect(sent.status).toBe(403);
    expect(await openStream(outsider.client, room.id)).toBe(403);
    expect(left.status).toBe(404);
  });

  it('keeps history readable but refuses posts once closed', async () => {
    const member = await registerChatter('member');
    const { ref, room } = await contextRoomFor(member.userId);
    await app.container.get(CHAT_CONTEXT_ROOMS).postSystemEvent({
      ref,
      code: 'item.started',
      params: { step: 1 },
    });
    await app.container.get(CHAT_CONTEXT_ROOMS).close({ ref });

    const sent = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'late' });
    const history = await member.client.get(`/chat/rooms/${room.id}/messages`);

    expect(sent.status).toBe(403);
    expect(history.status).toBe(200);
    expect(ChatMessageSchema.array().parse(await history.json())).toMatchObject([
      {
        type: 'system',
        actorId: CHAT_SYSTEM_AUTHOR_ID,
        metadata: { command: 'system_event', code: 'item.started', params: { step: 1 } },
      },
    ]);
  });

  it('audits the room, its members and its close as the system', async () => {
    const member = await registerChatter('member');
    const { ref, room } = await contextRoomFor(member.userId);
    await app.container.get(CHAT_CONTEXT_ROOMS).removeMember({ ref, userId: member.userId });
    await app.container.get(CHAT_CONTEXT_ROOMS).close({ ref });

    expect(await contextRoomAudit(room.id)).toEqual([
      expect.objectContaining({
        action: 'chat.context_room.created',
        actorType: 'system',
        after: { ref, name: 'Context' },
      }),
      expect.objectContaining({
        action: 'chat.context_room.member.added',
        actorType: 'system',
        after: { roomId: room.id, userId: member.userId },
      }),
      expect.objectContaining({
        action: 'chat.context_room.member.removed',
        actorType: 'system',
        before: { roomId: room.id, userId: member.userId },
      }),
      expect.objectContaining({
        action: 'chat.context_room.closed',
        actorType: 'system',
        after: { readOnlyMode: true },
      }),
    ]);
  });

  it('refuses an admin delete, so the ref keeps resolving', async () => {
    const { ref, room } = await contextRoomFor();

    const deleted = await admin.del(`/backoffice/chat/rooms/${room.id}`);

    expect(deleted.status).toBe(409);
    expect(await app.container.get(CHAT_CONTEXT_ROOMS).findRoom(ref)).toMatchObject({
      id: room.id,
    });
  });
});

describe('chat: deleting a system message', () => {
  it('refuses the room owner and lets staff delete it', async () => {
    const owner = await registerChatter('host');
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    const room = ChatRoomSchema.parse(await created.json());
    const message = await app.container.get(CHAT_SYSTEM_WRITER).postSystemMessage({
      roomId: room.id,
      metadata: { command: 'system_event', code: 'room.notice', params: {} },
    });

    const byOwner = await owner.client.del(`/chat/messages/${message.id}`);
    const byStaff = await admin.del(`/backoffice/chat/messages/${message.id}`);

    expect(byOwner.status).toBe(403);
    expect(byStaff.status).toBe(200);
  });
});
