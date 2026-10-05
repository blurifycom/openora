import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { adminRole, adminRolePermission, adminRoleAssignment } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';
import {
  ChatRoomRestrictionSchema,
  ChatRoomSchema,
  type ChatRoomRestriction,
} from '@openora/core/engagement/contracts/chat';
import {
  chatMute,
  chatPlatformBan,
  chatRoomBan,
  chatRoomMute,
} from '@openora/core/engagement/schema/chat';
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

const RestrictionPageSchema = paginated(ChatRoomRestrictionSchema);
const HOUR_MS = 3_600_000;

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let adminAccount: { id: string; name: string };
let globalRoomId: string;

async function registerChatter(prefix: string) {
  const username = `${prefix.slice(0, 7)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registered = await registerAndMaterializePlayer(app, {
    email: `${username}@e2e.test`,
    username,
  });
  return { ...registered, username };
}

async function registerBackofficeViewer(resource: 'chat-room' | 'chat-moderation') {
  const viewer = await registerChatter('viewer');
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, viewer.userId));
  const [role] = await drizzle
    .insert(adminRole)
    .values({ name: `${resource} viewer ${randomUUID()}` })
    .returning({ id: adminRole.id });
  await drizzle.insert(adminRolePermission).values({ roleId: role!.id, resource, level: 'read' });
  await drizzle.insert(adminRoleAssignment).values({ userId: viewer.userId, roleId: role!.id });
  return viewer;
}

async function createPublicRoom() {
  const suffix = randomUUID().slice(0, 8);
  const created = await admin.post('/backoffice/chat/rooms', {
    name: `Lobby ${suffix}`,
    slug: `lobby-${suffix}`,
    category: 'games-sports',
  });
  expect(created.status).toBe(200);
  return ChatRoomSchema.parse(await created.json());
}

async function createPrivateRoomWith(owner: TestClient, members: { client: TestClient }[]) {
  const created = await owner.post('/chat/rooms/private', { name: `room-${randomUUID()}` });
  expect(created.status).toBe(200);
  const room = ChatRoomSchema.parse(await created.json());
  for (const member of members) {
    expect((await member.client.post('/chat/rooms/join', { joinCode: room.joinCode })).status).toBe(
      200,
    );
  }
  return room;
}

async function adminRestrict(
  kind: 'mutes' | 'bans' | 'cooldowns',
  userId: string,
  roomId: string,
  durationSeconds: number | null = null,
) {
  const response = await admin.post(`/backoffice/chat/${kind}`, {
    userId,
    roomId,
    reason: `${kind} for ${userId}`,
    durationSeconds,
    ...(kind === 'cooldowns' ? { cooldownSeconds: 30 } : {}),
  });
  expect(response.status).toBe(200);
}

async function listRestrictions(roomId: string, query = '', client: TestClient = admin) {
  const response = await client.get(`/backoffice/chat/rooms/${roomId}/restrictions${query}`);
  expect(response.status).toBe(200);
  return RestrictionPageSchema.parse(await response.json());
}

const forUser = (items: ChatRoomRestriction[], userId: string) =>
  items.filter((item) => item.userId === userId);

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
  const [account] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  adminAccount = account!;
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

describe('chat admin: listing the restrictions in a room', () => {
  it('lists room-moderator and staff restrictions with who set them', async () => {
    const owner = await registerChatter('host');
    const flooder = await registerChatter('flooder');
    const troll = await registerChatter('troll');
    const room = await createPrivateRoomWith(owner.client, [flooder, troll]);
    const everywhere = await registerChatter('every');
    const throttled = await registerChatter('slowed');
    expect(
      (
        await owner.client.post(`/chat/rooms/${room.id}/mute`, {
          userId: flooder.userId,
          reason: 'flooding',
          durationSeconds: 3600,
        })
      ).status,
    ).toBe(200);
    expect(
      (await owner.client.post(`/chat/rooms/${room.id}/ban`, { userId: troll.userId })).status,
    ).toBe(200);
    await adminRestrict('mutes', everywhere.userId, '__all');
    await adminRestrict('cooldowns', throttled.userId, '__all', 3600);

    const { items } = await listRestrictions(room.id);

    expect(forUser(items, flooder.userId)).toEqual([
      {
        id: expect.any(String),
        type: 'mute',
        source: 'room',
        userId: flooder.userId,
        username: flooder.username,
        scope: 'room',
        roomId: room.id,
        reason: 'flooding',
        setBy: { id: owner.userId, name: owner.username },
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        cooldownSeconds: null,
      },
    ]);
    expect(forUser(items, troll.userId)).toEqual([
      expect.objectContaining({
        type: 'ban',
        source: 'room',
        scope: 'room',
        roomId: room.id,
        reason: null,
        setBy: { id: owner.userId, name: owner.username },
        expiresAt: null,
      }),
    ]);
    expect(forUser(items, everywhere.userId)).toEqual([
      expect.objectContaining({
        type: 'mute',
        source: 'admin',
        username: everywhere.username,
        scope: '__all',
        roomId: null,
        reason: `mutes for ${everywhere.userId}`,
        setBy: { id: adminAccount.id, name: adminAccount.name },
      }),
    ]);
    expect(forUser(items, throttled.userId)).toEqual([
      expect.objectContaining({
        type: 'cooldown',
        source: 'admin',
        username: throttled.username,
        scope: '__all',
        roomId: null,
        reason: `cooldowns for ${throttled.userId}`,
        setBy: { id: adminAccount.id, name: adminAccount.name },
        expiresAt: expect.any(String),
        cooldownSeconds: 30,
      }),
    ]);
  });

  it('reaches each room kind only through the platform scopes that cover it', async () => {
    const room = await createPublicRoom();
    const otherRoom = await createPublicRoom();
    const owner = await registerChatter('host');
    const roomMuted = await registerChatter('inroom');
    const publicBanned = await registerChatter('public');
    const allMuted = await registerChatter('all');
    const globalMuted = await registerChatter('global');
    const elsewhere = await registerChatter('else');
    const publicSlowed = await registerChatter('slowed');
    const privateRoom = await createPrivateRoomWith(owner.client, []);
    await adminRestrict('mutes', roomMuted.userId, room.id);
    await adminRestrict('bans', publicBanned.userId, '__all_public');
    await adminRestrict('mutes', allMuted.userId, '__all');
    await adminRestrict('mutes', globalMuted.userId, GLOBAL_CHAT_ROOM_ID);
    await adminRestrict('bans', elsewhere.userId, otherRoom.id);
    await adminRestrict('cooldowns', publicSlowed.userId, '__all_public');
    const seeded = [roomMuted, publicBanned, allMuted, globalMuted, elsewhere, publicSlowed].map(
      ({ userId }) => userId,
    );
    const reached = async (roomId: string) =>
      (await listRestrictions(roomId)).items
        .filter((item) => seeded.includes(item.userId))
        .map((item) => `${item.type}:${item.scope}:${item.userId}`)
        .sort();

    expect(await reached(room.id)).toEqual(
      [
        `mute:room:${roomMuted.userId}`,
        `ban:__all_public:${publicBanned.userId}`,
        `mute:__all:${allMuted.userId}`,
        `cooldown:__all_public:${publicSlowed.userId}`,
      ].sort(),
    );
    expect(await reached(GLOBAL_CHAT_ROOM_ID)).toEqual(
      [
        `ban:__all_public:${publicBanned.userId}`,
        `mute:__all:${allMuted.userId}`,
        `mute:__global:${globalMuted.userId}`,
        `cooldown:__all_public:${publicSlowed.userId}`,
      ].sort(),
    );
    expect(await reached(globalRoomId)).toEqual(await reached(GLOBAL_CHAT_ROOM_ID));
    expect(await reached(privateRoom.id)).toEqual([`mute:__all:${allMuted.userId}`]);
  });

  it('leaves out lifted and expired restrictions', async () => {
    const room = await createPublicRoom();
    const [active, lifted, expired, expiredInRoom, liftedInRoom] = await Promise.all(
      ['active', 'lifted', 'expired', 'expired', 'lifted'].map((prefix) => registerChatter(prefix)),
    );
    await adminRestrict('mutes', active!.userId, room.id);
    await adminRestrict('bans', lifted!.userId, room.id);
    await adminRestrict('cooldowns', lifted!.userId, room.id);
    expect(
      (
        await admin.post('/backoffice/chat/cooldowns/lift', {
          userId: lifted!.userId,
          roomId: room.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin.post('/backoffice/chat/bans/lift', { userId: lifted!.userId, roomId: room.id }))
        .status,
    ).toBe(200);
    const drizzle = app.container.get(DRIZZLE).db;
    const past = new Date(Date.now() - HOUR_MS);
    await drizzle.insert(chatMute).values({
      userId: expired!.userId,
      roomId: room.id,
      scope: 'room',
      mutedBy: adminAccount.id,
      reason: 'lapsed',
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: past,
    });
    await drizzle.insert(chatPlatformBan).values({
      userId: expired!.userId,
      roomId: null,
      scope: '__all_public',
      bannedBy: adminAccount.id,
      reason: 'lapsed',
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: past,
    });
    await drizzle.insert(chatRoomMute).values({
      roomId: room.id,
      userId: expiredInRoom!.userId,
      mutedBy: adminAccount.id,
      reason: 'lapsed',
      expiresAt: past,
    });
    await drizzle.insert(chatRoomBan).values({
      roomId: room.id,
      userId: liftedInRoom!.userId,
      bannedBy: adminAccount.id,
      liftedAt: past,
      liftedBy: adminAccount.id,
    });

    const { items } = await listRestrictions(room.id);

    expect(forUser(items, active!.userId)).toHaveLength(1);
    for (const gone of [lifted!, expired!, expiredInRoom!, liftedInRoom!]) {
      expect(forUser(items, gone.userId)).toEqual([]);
    }
  });

  it('filters by type and pages newest first', async () => {
    const owner = await registerChatter('host');
    const members = await Promise.all(
      ['m1', 'm2', 'm3', 'm4'].map((prefix) => registerChatter(prefix)),
    );
    const room = await createPrivateRoomWith(owner.client, members);
    for (const member of members.slice(0, 3)) {
      expect(
        (await owner.client.post(`/chat/rooms/${room.id}/mute`, { userId: member.userId })).status,
      ).toBe(200);
    }
    expect(
      (await owner.client.post(`/chat/rooms/${room.id}/ban`, { userId: members[3]!.userId }))
        .status,
    ).toBe(200);
    const publicRoom = await createPublicRoom();
    const otherRoom = await createPublicRoom();
    const slowed = await registerChatter('slowed');
    await adminRestrict('cooldowns', slowed.userId, publicRoom.id);

    const mutes = await listRestrictions(room.id, '?type=mute');
    const bans = await listRestrictions(room.id, '?type=ban');
    const cooldowns = await listRestrictions(room.id, '?type=cooldown');
    const everything = await listRestrictions(room.id);
    const firstPage = await listRestrictions(room.id, '?type=mute&page=1&limit=2');
    const secondPage = await listRestrictions(room.id, '?type=mute&page=2&limit=2');
    const publicCooldowns = await listRestrictions(publicRoom.id, '?type=cooldown');

    expect(forUser(publicCooldowns.items, slowed.userId)).toEqual([
      expect.objectContaining({
        type: 'cooldown',
        source: 'admin',
        scope: 'room',
        roomId: publicRoom.id,
        cooldownSeconds: 30,
      }),
    ]);
    expect(publicCooldowns.items.every((item) => item.type === 'cooldown')).toBe(true);
    expect(
      forUser((await listRestrictions(publicRoom.id, '?type=mute')).items, slowed.userId),
    ).toEqual([]);
    expect(forUser((await listRestrictions(otherRoom.id)).items, slowed.userId)).toEqual([]);
    expect(mutes.items.every((item) => item.type === 'mute')).toBe(true);
    expect(bans.items.every((item) => item.type === 'ban')).toBe(true);
    expect(cooldowns.items.every((item) => item.type === 'cooldown')).toBe(true);
    expect(everything.total).toBe(mutes.total + bans.total + cooldowns.total);
    expect(mutes.items.map((item) => item.userId)).toEqual(
      expect.arrayContaining(members.slice(0, 3).map((member) => member.userId)),
    );
    expect(forUser(bans.items, members[3]!.userId)).toHaveLength(1);
    const createdAt = everything.items.map((item) => Date.parse(item.createdAt));
    expect(createdAt).toEqual([...createdAt].sort((a, b) => b - a));
    expect(firstPage).toMatchObject({ total: mutes.total, page: 1, limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect([...firstPage.items, ...secondPage.items]).toEqual(mutes.items.slice(0, 4));
  });

  it('refuses a caller without the chat-moderation permission and an unknown or deleted room', async () => {
    const room = await createPublicRoom();
    const player = await registerChatter('player');
    const roomViewer = await registerBackofficeViewer('chat-room');
    const moderationViewer = await registerBackofficeViewer('chat-moderation');
    const path = `/backoffice/chat/rooms/${room.id}/restrictions`;

    expect((await app.app.request(path)).status).toBe(401);
    expect((await player.client.get(path)).status).toBe(403);
    expect((await roomViewer.client.get(path)).status).toBe(403);
    expect((await moderationViewer.client.get(path)).status).toBe(200);
    expect((await admin.get(`/backoffice/chat/rooms/${randomUUID()}/restrictions`)).status).toBe(
      404,
    );
    expect((await admin.del(`/backoffice/chat/rooms/${room.id}`)).status).toBe(200);
    expect((await admin.get(path)).status).toBe(404);
  });
});
