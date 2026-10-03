import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { adminRole, adminRolePermission, adminRoleAssignment } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';
import {
  AdminChatRoomSchema,
  ChatMessageSchema,
  ChatRoomSchema,
  ChatRoomRuleSchema,
  ChatRoomConfigurationSchema,
  ROOM_RULE_ORDER_MAX,
  type ChatRoomCategory,
} from '@openora/core/engagement/contracts/chat';
import { chatMessage } from '@openora/core/engagement/schema/chat';
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

async function registerChatRoomViewer() {
  const viewer = await registerChatter('viewer');
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, viewer.userId));
  const [role] = await drizzle
    .insert(adminRole)
    .values({ name: `chat room viewer ${randomUUID()}` })
    .returning({ id: adminRole.id });
  await drizzle
    .insert(adminRolePermission)
    .values({ roleId: role!.id, resource: 'chat-room', level: 'read' });
  await drizzle.insert(adminRoleAssignment).values({ userId: viewer.userId, roleId: role!.id });
  return viewer;
}

async function createPrivateRoom(owner: TestClient) {
  const created = await owner.post('/chat/rooms/private', { name: `room-${randomUUID()}` });
  expect(created.status).toBe(200);
  return ChatRoomSchema.parse(await created.json());
}

async function auditRows(action: string, resourceId: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

const clientHeaders = {
  'content-type': 'application/json',
  'x-real-ip': '203.0.113.7',
  'user-agent': 'backoffice-e2e',
};

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

describe('chat admin: reading a room', () => {
  it('lets a view-only admin who is not a member read a private room, its rules and configuration', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    expect(
      (await owner.client.post(`/chat/rooms/${room.id}/rules`, { content: 'Be kind' })).status,
    ).toBe(200);
    const viewer = await registerChatRoomViewer();

    const fetched = await viewer.client.get(`/backoffice/chat/rooms/${room.id}`);
    const rules = await viewer.client.get(`/backoffice/chat/rooms/${room.id}/rules`);
    const configuration = await viewer.client.get(
      `/backoffice/chat/rooms/${room.id}/configuration`,
    );

    expect(fetched.status).toBe(200);
    expect(room.joinCode).toEqual(expect.any(String));
    expect(ChatRoomSchema.parse(await fetched.json())).toMatchObject({
      id: room.id,
      isPublic: false,
      joinCode: null,
    });
    expect(rules.status).toBe(200);
    expect(
      ChatRoomRuleSchema.array()
        .parse(await rules.json())
        .map((rule) => rule.content),
    ).toEqual(['Be kind']);
    expect(configuration.status).toBe(200);
    expect(ChatRoomConfigurationSchema.parse(await configuration.json()).roomId).toBe(room.id);
  });

  it('refuses a player without the chat-room permission and an anonymous caller', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);

    for (const path of ['', '/rules', '/configuration']) {
      expect((await owner.client.get(`/backoffice/chat/rooms/${room.id}${path}`)).status).toBe(403);
      expect((await app.app.request(`/backoffice/chat/rooms/${room.id}${path}`)).status).toBe(401);
    }
  });

  it('answers not found for a deleted room', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const rule = ChatRoomRuleSchema.parse(
      await (
        await admin.post(`/backoffice/chat/rooms/${room.id}/rules`, { content: 'Be kind' })
      ).json(),
    );
    expect((await owner.client.del(`/chat/rooms/${room.id}`)).status).toBe(200);

    for (const path of ['', '/rules', '/configuration']) {
      expect((await admin.get(`/backoffice/chat/rooms/${room.id}${path}`)).status).toBe(404);
    }
    expect(
      (await admin.post(`/backoffice/chat/rooms/${room.id}/rules`, { content: 'Too late' })).status,
    ).toBe(404);
    expect(
      (await admin.patch(`/backoffice/chat/rooms/${room.id}/rules/${rule.id}`, { content: 'Edit' }))
        .status,
    ).toBe(404);
    expect((await admin.del(`/backoffice/chat/rooms/${room.id}/rules/${rule.id}`)).status).toBe(
      404,
    );
    expect(
      (await admin.patch(`/backoffice/chat/rooms/${room.id}/configuration`, { readOnlyMode: true }))
        .status,
    ).toBe(404);
  });
});

describe('chat admin: room rules', () => {
  it('creates, reorders and deletes a rule in a room the admin is not in, auditing each as admin', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const rulesPath = `/backoffice/chat/rooms/${room.id}/rules`;

    const created = await admin.request(rulesPath, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ content: 'No spam' }),
    });
    expect(created.status).toBe(200);
    const rule = ChatRoomRuleSchema.parse(await created.json());
    const second = ChatRoomRuleSchema.parse(
      await (await admin.post(rulesPath, { content: 'No links' })).json(),
    );
    expect(second.orderNum).toBe(rule.orderNum + 1);

    const reordered = await admin.request(`${rulesPath}/${rule.id}`, {
      method: 'PATCH',
      headers: clientHeaders,
      body: JSON.stringify({ orderNum: second.orderNum + 1, content: 'No spam, ever' }),
    });
    expect(reordered.status).toBe(200);
    const listed = ChatRoomRuleSchema.array().parse(await (await admin.get(rulesPath)).json());
    expect(listed.map((r) => r.content)).toEqual(['No links', 'No spam, ever']);

    const deleted = await admin.request(`${rulesPath}/${rule.id}`, {
      method: 'DELETE',
      headers: clientHeaders,
    });
    expect(deleted.status).toBe(200);
    expect(
      ChatRoomRuleSchema.array()
        .parse(await (await admin.get(rulesPath)).json())
        .map((r) => r.id),
    ).toEqual([second.id]);

    const [createdRow] = await auditRows('chat.room.rule.created', rule.id);
    const [updatedRow] = await auditRows('chat.room.rule.updated', rule.id);
    const [deletedRow] = await auditRows('chat.room.rule.deleted', rule.id);
    for (const row of [createdRow, updatedRow, deletedRow]) {
      expect(row).toMatchObject({
        actorType: 'admin',
        resourceType: 'chat_room_rule',
        ip: '203.0.113.7',
        userAgent: 'backoffice-e2e',
      });
      expect(row?.actorId).toEqual(expect.any(String));
    }
    expect(createdRow?.after).toMatchObject({ roomId: room.id, content: 'No spam' });
    expect(updatedRow?.before).toMatchObject({ roomId: room.id, content: 'No spam' });
    expect(updatedRow?.after).toMatchObject({ roomId: room.id, content: 'No spam, ever' });
    expect(deletedRow?.before).toMatchObject({ roomId: room.id, content: 'No spam, ever' });
    expect(
      (await admin.post(rulesPath, { content: 'Last', orderNum: ROOM_RULE_ORDER_MAX + 1 })).status,
    ).toBe(400);
  });

  it('answers not found for a rule that belongs to another room', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const other = await createPrivateRoom(owner.client);
    const rule = ChatRoomRuleSchema.parse(
      await (
        await admin.post(`/backoffice/chat/rooms/${other.id}/rules`, { content: 'Elsewhere' })
      ).json(),
    );

    const patched = await admin.patch(`/backoffice/chat/rooms/${room.id}/rules/${rule.id}`, {
      content: 'Hijacked',
    });
    const deleted = await admin.del(`/backoffice/chat/rooms/${room.id}/rules/${rule.id}`);

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
  });

  it('refuses rule writes from a view-only admin', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const rule = ChatRoomRuleSchema.parse(
      await (
        await admin.post(`/backoffice/chat/rooms/${room.id}/rules`, { content: 'Be kind' })
      ).json(),
    );
    const viewer = await registerChatRoomViewer();
    const rulesPath = `/backoffice/chat/rooms/${room.id}/rules`;

    expect((await viewer.client.post(rulesPath, { content: 'Mine' })).status).toBe(403);
    expect((await viewer.client.patch(`${rulesPath}/${rule.id}`, { content: 'Mine' })).status).toBe(
      403,
    );
    expect((await viewer.client.del(`${rulesPath}/${rule.id}`)).status).toBe(403);
  });
});

describe('chat admin: room status', () => {
  it('puts the global room into read-only mode by its row id, blocking player posts', async () => {
    const player = await registerChatter('global');
    const configurationPath = `/backoffice/chat/rooms/${globalRoomId}/configuration`;

    const readOnly = await admin.request(configurationPath, {
      method: 'PATCH',
      headers: clientHeaders,
      body: JSON.stringify({ readOnlyMode: true }),
    });

    try {
      expect(readOnly.status).toBe(200);
      expect(ChatRoomConfigurationSchema.parse(await readOnly.json())).toMatchObject({
        roomId: globalRoomId,
        readOnlyMode: true,
      });
      expect((await player.client.post('/chat/global', { content: 'hello' })).status).toBe(403);
      const rows = await auditRows(
        'chat.room.configuration.updated',
        ChatRoomConfigurationSchema.parse(await (await admin.get(configurationPath)).json()).id,
      );
      expect(rows).toEqual([
        expect.objectContaining({
          actorType: 'admin',
          ip: '203.0.113.7',
          userAgent: 'backoffice-e2e',
          after: expect.objectContaining({ roomId: globalRoomId, readOnlyMode: true }),
        }),
      ]);
    } finally {
      await admin.patch(configurationPath, { readOnlyMode: false });
    }

    expect((await player.client.post('/chat/global', { content: 'hello again' })).status).toBe(200);
  });

  it('sets slow mode and ignores settings outside read-only and slow mode', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const configurationPath = `/backoffice/chat/rooms/${room.id}/configuration`;

    const slowed = await admin.patch(configurationPath, {
      slowMode: true,
      slowModeSeconds: 30,
      lockRoom: true,
    });
    const onlyForeign = await admin.patch(configurationPath, { lockRoom: true });

    expect(slowed.status).toBe(200);
    expect(ChatRoomConfigurationSchema.parse(await slowed.json())).toMatchObject({
      slowMode: true,
      slowModeSeconds: 30,
      lockRoom: false,
    });
    expect(onlyForeign.status).toBe(400);
    expect((await admin.patch(configurationPath, { slowModeSeconds: 2 ** 31 })).status).toBe(400);
  });

  it('refuses a status change from a view-only admin', async () => {
    const owner = await registerChatter('host');
    const room = await createPrivateRoom(owner.client);
    const viewer = await registerChatRoomViewer();

    const changed = await viewer.client.patch(`/backoffice/chat/rooms/${room.id}/configuration`, {
      readOnlyMode: true,
    });

    expect(changed.status).toBe(403);
  });
});

describe('chat admin: listing rooms', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;

  async function createPublicRoom(name: string, category: ChatRoomCategory) {
    const created = await admin.post('/backoffice/chat/rooms', {
      name,
      slug: `list-${randomUUID()}`,
      category,
    });
    expect(created.status).toBe(200);
    return ChatRoomSchema.parse(await created.json());
  }

  async function listRooms(query: Record<string, string>) {
    const listed = await admin.get(`/backoffice/chat/rooms?${new URLSearchParams(query)}`);
    expect(listed.status).toBe(200);
    return paginated(AdminChatRoomSchema).parse(await listed.json());
  }

  async function postMessage(client: TestClient, roomId: string, content: string) {
    const posted = await client.post(`/chat/rooms/${roomId}/messages`, { content });
    expect(posted.status).toBe(200);
    return ChatMessageSchema.parse(await posted.json());
  }

  it('narrows public rooms to one category and keeps private rooms out', async () => {
    const tag = `cat-${randomUUID().slice(0, 8)}`;
    const regions = await createPublicRoom(`${tag} europe`, 'regions');
    const moreRegions = await createPublicRoom(`${tag} asia`, 'regions');
    await createPublicRoom(`${tag} english`, 'languages');
    const owner = await registerChatter('host');
    expect(
      (await owner.client.post('/chat/rooms/private', { name: `${tag} private` })).status,
    ).toBe(200);

    const filtered = await listRooms({ name: tag, category: 'regions', sortBy: 'name' });
    const unfiltered = await listRooms({ name: tag });
    const privateOnly = await listRooms({ name: tag, category: 'private-channels' });

    expect(filtered.total).toBe(2);
    expect(filtered.items.map((room) => room.id).sort()).toEqual(
      [regions.id, moreRegions.id].sort(),
    );
    expect(unfiltered.total).toBe(3);
    expect(privateOnly).toMatchObject({ total: 0, items: [] });
  });

  it('rejects an unknown category and a player without the chat-room permission', async () => {
    const player = await registerChatter('player');

    expect((await admin.get('/backoffice/chat/rooms?category=casino')).status).toBe(400);
    expect((await player.client.get('/backoffice/chat/rooms')).status).toBe(403);
  });

  it('counts members and the last 24 hours of visible player messages per room', async () => {
    const tag = `stats-${randomUUID().slice(0, 8)}`;
    const busy = await createPublicRoom(`${tag} busy`, 'games-sports');
    const quiet = await createPublicRoom(`${tag} quiet`, 'games-sports');
    const first = await registerChatter('first');
    const second = await registerChatter('second');
    for (const chatter of [first, second]) {
      expect((await chatter.client.post(`/chat/rooms/${busy.id}/join`)).status).toBe(200);
    }
    const latestVisible = await postMessage(first.client, busy.id, 'still here');
    const removed = await postMessage(second.client, busy.id, 'gone soon');
    expect((await admin.del(`/backoffice/chat/messages/${removed.id}`)).status).toBe(200);
    const now = Date.now();
    const seed = { roomId: busy.id, userId: first.userId, username: 'first', content: 'old' };
    await app.container
      .get(DRIZZLE)
      .db.insert(chatMessage)
      .values([
        { ...seed, createdAt: new Date(now - DAY_MS + 5 * MINUTE_MS) },
        { ...seed, createdAt: new Date(now - DAY_MS - 5 * MINUTE_MS) },
        { ...seed, type: 'system', content: 'rain landed', createdAt: new Date(now) },
      ]);

    const { items } = await listRooms({ name: tag, sortBy: 'name', sortOrder: 'asc' });

    expect(items.map((room) => room.id)).toEqual([busy.id, quiet.id]);
    expect(items[0]).toMatchObject({
      memberCount: 3,
      messageCount24h: 2,
      lastMessageAt: latestVisible.createdAt,
    });
    expect(items[1]).toMatchObject({ memberCount: 1, messageCount24h: 0, lastMessageAt: null });
  });

  it('reports the global room without a member count, from its messages', async () => {
    const chatter = await registerChatter('global');
    const posted = await chatter.client.post('/chat/global', { content: 'hello everyone' });
    expect(posted.status).toBe(200);
    const message = ChatMessageSchema.parse(await posted.json());

    const { items } = await listRooms({ name: 'Global' });
    const globalRoom = items.find((room) => room.id === globalRoomId);

    expect(globalRoom?.memberCount).toBeNull();
    expect(globalRoom?.messageCount24h).toBeGreaterThanOrEqual(1);
    expect(Date.parse(globalRoom?.lastMessageAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(message.createdAt),
    );
  });
});
