import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { ChatCooldownEntrySchema, ChatRoomSchema } from '@openora/core/engagement/contracts/chat';
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

async function registerChatter(prefix: string) {
  const username = `${prefix.slice(0, 7)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  return registerAndMaterializePlayer(app, { email: `${username}@e2e.test`, username });
}

async function createPublicRoom() {
  const created = await admin.post('/backoffice/chat/rooms', {
    name: `public-${randomUUID()}`,
    slug: `public-${randomUUID()}`,
    category: 'games-sports',
  });
  expect(created.status).toBe(200);
  return ChatRoomSchema.parse(await created.json());
}

async function listCooldowns(userId: string) {
  const listed = await admin.get(`/backoffice/chat/cooldowns?userIds=${userId}`);
  expect(listed.status).toBe(200);
  return ChatCooldownEntrySchema.array().parse(await listed.json());
}

const refusalReason = async (response: Response) =>
  ((await response.json()) as { data?: { reason?: string } }).data?.reason;

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

describe('chat: back-office player cooldowns', () => {
  it('holds a player to a global cooldown, lists it, and lifts it', async () => {
    const player = await registerChatter('flood');
    const send = () => player.client.post('/chat/global', { content: 'hello' });
    const set = await admin.post('/backoffice/chat/cooldowns', {
      userId: player.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      cooldownSeconds: 60,
      reason: 'flooding',
      durationSeconds: 3600,
    });
    expect(set.status).toBe(200);

    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(403);
    expect(await refusalReason(refused)).toBe('slow_mode');
    expect(await listCooldowns(player.userId)).toEqual([
      expect.objectContaining({
        userId: player.userId,
        roomId: null,
        scope: GLOBAL_CHAT_ROOM_ID,
        cooldownSeconds: 60,
        reason: 'flooding',
      }),
    ]);

    const lift = { userId: player.userId, roomId: GLOBAL_CHAT_ROOM_ID };
    expect((await admin.post('/backoffice/chat/cooldowns/lift', lift)).status).toBe(200);
    expect((await admin.post('/backoffice/chat/cooldowns/lift', lift)).status).toBe(200);
    expect(await listCooldowns(player.userId)).toEqual([]);
    expect((await send()).status).toBe(200);
  });

  it('shares one window across every room an all-chats cooldown covers', async () => {
    const player = await registerChatter('hopper');
    const [first, second] = [await createPublicRoom(), await createPublicRoom()];
    for (const room of [first, second]) {
      expect((await player.client.post(`/chat/rooms/${room.id}/join`)).status).toBe(200);
    }
    const set = await admin.post('/backoffice/chat/cooldowns', {
      userId: player.userId,
      roomId: '__all',
      cooldownSeconds: 60,
      reason: 'room hopping',
    });
    expect(set.status).toBe(200);

    const sendTo = (roomId: string) =>
      player.client.post(`/chat/rooms/${roomId}/messages`, { content: 'hi' });

    expect((await sendTo(first.id)).status).toBe(200);
    expect((await sendTo(second.id)).status).toBe(403);
    expect((await player.client.post('/chat/global', { content: 'hi' })).status).toBe(403);
  });

  it('replaces the active cooldown and audits the previous one', async () => {
    const player = await registerChatter('replace');
    const body = { userId: player.userId, roomId: '__all_public', reason: 'first' };
    expect(
      (await admin.post('/backoffice/chat/cooldowns', { ...body, cooldownSeconds: 30 })).status,
    ).toBe(200);
    expect(
      (
        await admin.post('/backoffice/chat/cooldowns', {
          ...body,
          cooldownSeconds: 120,
          reason: 'second',
        })
      ).status,
    ).toBe(200);

    expect(await listCooldowns(player.userId)).toEqual([
      expect.objectContaining({ scope: '__all_public', cooldownSeconds: 120, reason: 'second' }),
    ]);
    const trail = await app.container
      .get(DRIZZLE)
      .db.select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'chat.cooldown.created'),
          eq(auditLog.resourceType, 'chat_player_cooldown'),
        ),
      )
      .orderBy(asc(auditLog.createdAt));
    const forPlayer = trail.filter(
      (row) => (row.after as Record<string, unknown>)['userId'] === player.userId,
    );
    expect(forPlayer).toHaveLength(2);
    expect(forPlayer[0]!.before).toBeNull();
    expect(forPlayer[1]!.before).toMatchObject({ cooldownSeconds: 30, reason: 'first' });
  });

  it('refuses the cooldown routes to a player', async () => {
    const player = await registerChatter('rogue');
    const target = await registerChatter('target');
    const body = {
      userId: target.userId,
      roomId: GLOBAL_CHAT_ROOM_ID,
      cooldownSeconds: 30,
      reason: 'x',
    };

    expect((await player.client.post('/backoffice/chat/cooldowns', body)).status).toBe(403);
    expect((await player.client.post('/backoffice/chat/cooldowns/lift', body)).status).toBe(403);
    expect(
      (await player.client.get(`/backoffice/chat/cooldowns?userId=${target.userId}`)).status,
    ).toBe(403);
  });

  it('rejects an unknown room, a private room and an out-of-range interval', async () => {
    const owner = await registerChatter('host');
    const target = await registerChatter('target');
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    const privateRoom = ChatRoomSchema.parse(await created.json());
    const set = (overrides: Record<string, unknown>) =>
      admin.post('/backoffice/chat/cooldowns', {
        userId: target.userId,
        roomId: GLOBAL_CHAT_ROOM_ID,
        cooldownSeconds: 30,
        reason: 'x',
        ...overrides,
      });

    expect((await set({ roomId: randomUUID() })).status).toBe(404);
    expect((await set({ roomId: privateRoom.id })).status).toBe(400);
    expect((await set({ cooldownSeconds: 0 })).status).toBe(400);
    expect((await set({ cooldownSeconds: 86_401 })).status).toBe(400);
    expect(await listCooldowns(target.userId)).toEqual([]);
  });
});
