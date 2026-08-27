import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  createTestDb,
  InProcessRealtimeTransport,
  type TestDb,
  seedUser,
} from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import type {
  AdminUserDirectory,
  AdminPlayerSummary,
  AuditWritePort,
  FriendshipDissolvedPayload,
  RealtimeTransport,
  SocialCommands,
} from '@openora/core/contracts';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { NO_CLIENT_META, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { CHAT_ROOM_CATEGORIES, type ChatMessage } from '../contract/index.js';
import {
  CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
  MAX_PRIVATE_ROOMS_PER_PLAYER,
} from '../contract/constants.js';
import { migrate } from '../migrate.js';
// import {
//   mock,
//   mockDb,
//   makeDrizzle,
//   makeEvents,
//   readPrivate,
//   NO_CLIENT_META,
// } from '../../../testing/mock.js';
import { chatChannel } from '@openora/core/contracts';
import {
  ChatService,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatSelfIgnoreError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
  ChatRoomLimitReachedError,
  ChatRoomLastModeratorError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
  ChatRoomOwnershipError,
} from '../service/chat.service.js';
import {
  ChatModerationService,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatPlayerMutedError,
  ChatPlayerBannedError,
  ChatAdminPrivateRoomModerationError,
} from '../service/chat-moderation.service.js';
import {
  chatMessage,
  chatRoom,
  chatRoomMember,
  chatRoomBan,
  chatRoomRule,
  chatRoomConfiguration,
  chatRoomMute,
  chatRoomRemove,
  chatUserBlock,
  chatUserIgnore,
  chatMute,
  chatPlatformBan,
} from '../schema/index.js';
import { ChatRoomMembershipService } from '../service/chat-room-membership.service.js';
import { ChatRoomBanService } from '../service/chat-room-ban.service.js';
import { ChatRoomMuteService } from '../service/chat-room-mute.service.js';
let db: TestDb;

function makeService(
  directory: AdminUserDirectory = mock<AdminUserDirectory>({
    lookupPlayers: async () => [],
    lookupUsers: async (ids: readonly string[]) =>
      ids.map((id) => ({
        id,
        email: `${id}@example.com`,
        name: id,
        createdAt: new Date(),
        isActive: true,
        role: 'player',
      })),
  }),
  socialCommands?: SocialCommands,
  transport: RealtimeTransport = new InProcessRealtimeTransport(),
) {
  const events = makeEventBus();
  const audit = mock<AuditWritePort>({
    record: vi.fn().mockResolvedValue(undefined),
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
  });
  const moderation = new ChatModerationService(db.drizzle, transport, audit);
  const identityReader = makeIdentityReader();
  const chatService = new ChatService(
    db.drizzle,
    events,
    transport,
    directory,
    audit,
    moderation,
    identityReader,
    socialCommands,
  );
  const membership = new ChatRoomMembershipService(
    db.drizzle,
    events,
    audit,
    transport,
    identityReader,
  );
  const roomBan = new ChatRoomBanService(db.drizzle, events, audit, transport, identityReader);
  const roomMute = new ChatRoomMuteService(db.drizzle, audit);
  return {
    moderation,
    svc: Object.assign(chatService, {
      joinRoom: membership.joinRoom.bind(membership),
      joinPublicRoom: membership.joinPublicRoom.bind(membership),
      adminJoinRoom: membership.adminJoinRoom.bind(membership),
      leaveRoom: membership.leaveRoom.bind(membership),
      removeMember: membership.removeMember.bind(membership),
      setMemberRole: membership.setMemberRole.bind(membership),
      banMember: roomBan.banMember.bind(roomBan),
      unbanMember: roomBan.unbanMember.bind(roomBan),
      muteRoomMember: roomMute.muteRoomMember.bind(roomMute),
      unmuteRoomMember: roomMute.unmuteRoomMember.bind(roomMute),
    }),
    events,
    transport,
    audit,
  };
}

async function seedRoom(overrides: Partial<typeof chatRoom.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatRoom)
    .values({
      name: 'Wheel Spin',
      slug: `room-${randomUUID()}`,
      category: 'games-sports',
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedMessage(overrides: Partial<typeof chatMessage.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatMessage)
    .values({
      roomId: null,
      userId: randomUUID(),
      username: 'alice',
      content: 'hi',
      ...overrides,
    })
    .returning();
  return row!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met within the timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateIdentity, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMessage}, ${chatRoomRule}, ${chatRoomConfiguration}, ${chatRoomMember}, ${chatRoomBan}, ${chatRoomMute}, ${chatRoomRemove}, ${chatMute}, ${chatPlatformBan}, ${chatUserBlock}, ${chatUserIgnore}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('Chat contract surface', () => {
  it('exposes the complete persisted category set', () => {
    expect(CHAT_ROOM_CATEGORIES).toEqual([
      'games-sports',
      'regions',
      'languages',
      'private-channels',
    ]);
  });
});

describe('ChatService realtime wiring', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: 'r1',
    userId: 'u1',
    username: 'alice',
    content: 'hi',
    type: 'user',
    metadata: null,
    isDeleted: false,
    createdAt: '2026-05-29T00:00:00.000Z',
  };

  it('maps room vs global channels', () => {
    expect(chatChannel(null)).toBe('chat:global');
    expect(chatChannel('r1')).toBe('chat:room:r1');
  });

  it('delivers messages published on a room channel, then stops on unsubscribe', () => {
    const { svc, transport } = makeService();
    const got: ChatMessage[] = [];
    const unsub = svc.subscribeMessages('r1', (m) => got.push(m));

    transport.publish(chatChannel('r1'), sample);
    expect(got).toEqual([sample]);

    transport.publish(chatChannel(null), { ...sample, roomId: null });
    expect(got).toHaveLength(1);

    unsub();
    transport.publish(chatChannel('r1'), sample);
    expect(got).toHaveLength(1);
  });

  it('counts each authenticated user once across multiple stream connections', async () => {
    const { svc } = makeService();
    const first = svc.subscribeMessages('r1', () => undefined, 'u1', 'tab-1');
    const second = svc.subscribeMessages('r1', () => undefined, 'u1', 'tab-2');

    await expect(svc.getOnlineCount('r1')).resolves.toEqual({ count: 1 });
    first();
    await expect(svc.getOnlineCount('r1')).resolves.toEqual({ count: 1 });
    second();
    await expect(svc.getOnlineCount('r1')).resolves.toEqual({ count: 0 });
  });

  it('excludes admin and super-admin users from the online count', async () => {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: async () => [],
      lookupUsers: async (ids: readonly string[]) =>
        ids.map((id) => ({
          id,
          email: `${id}@example.com`,
          name: id,
          createdAt: new Date(),
          isActive: true,
          role: id === 'admin' ? 'admin' : id === 'super-admin' ? 'super-admin' : 'player',
        })),
    });
    const { svc } = makeService(directory);
    const playerUnsubscribe = svc.subscribeMessages('r1', () => undefined, 'player');
    const adminUnsubscribe = svc.subscribeMessages('r1', () => undefined, 'admin');
    const superAdminUnsubscribe = svc.subscribeMessages('r1', () => undefined, 'super-admin');

    await expect(svc.getOnlineCount('r1')).resolves.toEqual({ count: 1 });

    playerUnsubscribe();
    adminUnsubscribe();
    superAdminUnsubscribe();
  });
});

describe('ChatService.subscribeMessages per-viewer block filtering (real PG)', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: null,
    userId: 'sender',
    username: 'alice',
    content: 'hi',
    type: 'user',
    metadata: null,
    isDeleted: false,
    createdAt: '2026-05-29T00:00:00.000Z',
  };

  it('hides messages from blocked senders for the viewer, delivers the rest', async () => {
    const { svc, transport } = makeService();
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(viewerId, blockedId);

    const got: ChatMessage[] = [];
    svc.subscribeMessages(null, (m) => got.push(m), viewerId);
    transport.publish(chatChannel(null), { ...sample, userId: 'other-user' });
    await waitFor(() => got.length === 1);

    transport.publish(chatChannel(null), { ...sample, userId: blockedId });

    expect(got.map((m) => m.userId)).toEqual(['other-user']);
  });

  it('buffers messages that arrive before the block set loads, then filters on flush', async () => {
    const { svc, transport } = makeService();
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(viewerId, blockedId);

    const got: ChatMessage[] = [];
    svc.subscribeMessages(null, (m) => got.push(m), viewerId);
    transport.publish(chatChannel(null), { ...sample, userId: blockedId });
    transport.publish(chatChannel(null), { ...sample, userId: 'other-user' });
    expect(got).toHaveLength(0);

    await waitFor(() => got.length === 1);

    expect(got.map((m) => m.userId)).toEqual(['other-user']);
  });

  it('delivers everything to an anonymous viewer', async () => {
    const { svc, transport } = makeService();
    const got: ChatMessage[] = [];
    svc.subscribeMessages(null, (m) => got.push(m));

    transport.publish(chatChannel(null), sample);

    expect(got).toHaveLength(1);
  });

  it('hides messages from an ignored (not blocked) sender for the viewer', async () => {
    const { svc, transport } = makeService();
    const viewerId = randomUUID();
    const ignoredId = randomUUID();
    await svc.ignoreUser(viewerId, ignoredId);

    const got: ChatMessage[] = [];
    svc.subscribeMessages(null, (m) => got.push(m), viewerId);
    transport.publish(chatChannel(null), { ...sample, userId: 'other-user' });
    await waitFor(() => got.length === 1);

    transport.publish(chatChannel(null), { ...sample, userId: ignoredId });

    expect(got.map((m) => m.userId)).toEqual(['other-user']);
  });
});

describe('ChatService.sendGlobalMessage (real PG)', () => {
  it('stores the username from the verified user, ignoring the header fallback', async () => {
    const { svc, events } = makeService();
    const account = await seedUser(db, { name: 'Platform Admin', username: 'platform_admin' });

    const msg = await svc.sendGlobalMessage(account.id, 'spoofed-header-name', 'hi');

    expect(msg.username).toBe('platform_admin');
    const [stored] = await db.drizzle.db.select().from(chatMessage);
    expect(stored).toMatchObject({ roomId: null, username: 'platform_admin' });
    expect(events.emit).toHaveBeenCalledWith('chat.message.sent', {
      messageId: msg.id,
      roomId: null,
      userId: account.id,
    });
  });

  it('falls back to the passed name, then anonymous, when no user row exists', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    expect((await svc.sendGlobalMessage(userId, 'fallback', 'hi')).username).toBe('fallback');
    expect((await svc.sendGlobalMessage(userId, '', 'hi')).username).toBe('anonymous');
  });

  it('blocks profane messages before they are stored or published', async () => {
    const { svc, transport } = makeService();
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>('chat:global', (m) => delivered.push(m));

    await expect(svc.sendGlobalMessage(randomUUID(), 'Alice', 'this is shit')).rejects.toThrow(
      ChatMessageBlockedError,
    );

    expect(delivered).toHaveLength(0);
    expect(await db.drizzle.db.select().from(chatMessage)).toHaveLength(0);
  });

  it('persists URL-sanitized content', async () => {
    const { svc } = makeService();

    const msg = await svc.sendGlobalMessage(randomUUID(), 'Alice', 'click javascript:alert(1)');

    expect(msg.content).toBe('click javascript alert(1)');
    const [stored] = await db.drizzle.db.select().from(chatMessage);
    expect(stored?.content).toBe('click javascript alert(1)');
  });

  it('publishes the stored message on the global channel', async () => {
    const { svc, transport } = makeService();
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>('chat:global', (m) => delivered.push(m));

    const msg = await svc.sendGlobalMessage(randomUUID(), 'Alice', 'hello');

    expect(delivered.map((m) => m.id)).toEqual([msg.id]);
  });
});

describe('ChatService message reads (real PG)', () => {
  it('returns global messages newest-first, excluding soft-deleted ones', async () => {
    const { svc } = makeService();
    const older = await seedMessage({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = await seedMessage({ createdAt: new Date('2026-02-01T00:00:00.000Z') });
    await seedMessage({ isDeleted: true });

    const messages = await svc.getGlobalMessages();

    expect(messages.map((m) => m.id)).toEqual([newer.id, older.id]);
  });

  it('filters out senders the viewer has blocked', async () => {
    const { svc } = makeService();
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(viewerId, blockedId);
    await seedMessage({ userId: blockedId });
    const visible = await seedMessage();

    const messages = await svc.getGlobalMessages(50, viewerId);

    expect(messages.map((m) => m.id)).toEqual([visible.id]);
  });

  it('filters out senders the viewer has ignored (not blocked)', async () => {
    const { svc } = makeService();
    const viewerId = randomUUID();
    const ignoredId = randomUUID();
    await svc.ignoreUser(viewerId, ignoredId);
    await seedMessage({ userId: ignoredId });
    const visible = await seedMessage();

    const messages = await svc.getGlobalMessages(50, viewerId);

    expect(messages.map((m) => m.id)).toEqual([visible.id]);
  });

  it('scopes room messages to the room and honours the before cursor', async () => {
    const { svc } = makeService();
    const room = await seedRoom();
    const old = await seedMessage({
      roomId: room.id,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await seedMessage({ roomId: room.id, createdAt: new Date('2026-03-01T00:00:00.000Z') });
    await seedMessage();

    const messages = await svc.getRoomMessages({
      roomId: room.id,
      before: '2026-02-01T00:00:00.000Z',
    });

    expect(messages.map((m) => m.id)).toEqual([old.id]);
  });

  it('filters out room senders the viewer has ignored (not blocked)', async () => {
    const { svc } = makeService();
    const viewerId = randomUUID();
    const ignoredId = randomUUID();
    const room = await seedRoom();
    await svc.ignoreUser(viewerId, ignoredId);
    await seedMessage({ roomId: room.id, userId: ignoredId });
    const visible = await seedMessage({ roomId: room.id });

    const messages = await svc.getRoomMessages({ roomId: room.id, viewerId });

    expect(messages.map((m) => m.id)).toEqual([visible.id]);
  });
});

describe('ChatService.sendRoomMessage (real PG)', () => {
  it('stores and publishes a message in a public room', async () => {
    const { svc, transport } = makeService();
    const room = await seedRoom();
    const account = await seedUser(db, { name: 'Alice', username: 'alice' });
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>(chatChannel(room.id), (m) => delivered.push(m));

    const msg = await svc.sendRoomMessage({
      userId: account.id,
      username: 'ignored',
      roomId: room.id,
      content: 'hello room',
    });

    expect(msg).toMatchObject({ roomId: room.id, username: 'alice' });
    expect(delivered.map((m) => m.id)).toEqual([msg.id]);
  });

  it('refuses a private room the sender has not joined', async () => {
    const { svc } = makeService();
    const room = await seedRoom({ isPublic: false, category: 'private-channels' });

    await expect(
      svc.sendRoomMessage({
        userId: randomUUID(),
        username: 'a',
        roomId: room.id,
        content: 'hi',
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotMemberError);
    expect(await db.drizzle.db.select().from(chatMessage)).toHaveLength(0);
  });
});

describe('ChatService.deleteMessage (real PG)', () => {
  it('soft-deletes a message for a room owner and publishes a tombstone', async () => {
    const { svc } = makeService();
    const ownerId = randomUUID();
    const globalRoom = await seedRoom({ slug: '__global', isPublic: true });
    await db.drizzle.db
      .insert(chatRoomMember)
      .values({ roomId: globalRoom.id, userId: ownerId, role: 'owner' });
    const message = await seedMessage();

    await expect(svc.deleteMessage(message.id, ownerId)).resolves.toEqual({ success: true });

    const [stored] = await db.drizzle.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.id, message.id));
    expect(stored?.isDeleted).toBe(true);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

  it('throws ChatMessageNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.deleteMessage(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      ChatMessageNotFoundError,
    );
  });

  it('refuses deletion by a regular room member', async () => {
    const { svc } = makeService();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const globalRoom = await seedRoom({ slug: '__global', isPublic: true });
    await db.drizzle.db.insert(chatRoomMember).values([
      { roomId: globalRoom.id, userId: ownerId, role: 'owner' },
      { roomId: globalRoom.id, userId: memberId, role: 'member' },
    ]);
    const message = await seedMessage();

    await expect(svc.deleteMessage(message.id, memberId)).rejects.toBeInstanceOf(
      ChatRoomNotModeratorError,
    );
  });
});

describe('ChatService block list (real PG)', () => {
  it('rejects blocking yourself', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    await expect(svc.blockUser(userId, userId)).rejects.toThrow(ChatSelfBlockError);
  });

  it('dissolves any friendship on the same tx as the block insert, before returning', async () => {
    const dissolveFriendshipOnBlock = vi.fn(async () => {});
    const { svc } = makeService(undefined, mock<SocialCommands>({ dissolveFriendshipOnBlock }));
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    expect(dissolveFriendshipOnBlock).toHaveBeenCalledTimes(1);
    expect(dissolveFriendshipOnBlock).toHaveBeenCalledWith(expect.anything(), blockerId, blockedId);
  });

  it('does not call the social port again on a no-op re-block', async () => {
    const dissolveFriendshipOnBlock = vi.fn(async () => {});
    const { svc } = makeService(undefined, mock<SocialCommands>({ dissolveFriendshipOnBlock }));
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await svc.blockUser(blockerId, blockedId);
    await svc.blockUser(blockerId, blockedId);

    expect(dissolveFriendshipOnBlock).toHaveBeenCalledTimes(1);
  });

  it('emits the dissolved-friendship event only after the block transaction commits', async () => {
    const payload: FriendshipDissolvedPayload = {
      friendshipId: randomUUID(),
      actorId: randomUUID(),
      actorPlayerId: randomUUID(),
      otherUserId: randomUUID(),
      reason: 'blocked',
    };
    const dissolveFriendshipOnBlock = vi.fn(async () => payload);
    const { svc, events } = makeService(
      undefined,
      mock<SocialCommands>({ dissolveFriendshipOnBlock }),
    );
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    expect(events.emit).toHaveBeenCalledWith('social.friendship.removed', payload);
  });

  it('does not emit a dissolved-friendship event when there was no active friendship to dissolve', async () => {
    const dissolveFriendshipOnBlock = vi.fn(async () => null);
    const { svc, events } = makeService(
      undefined,
      mock<SocialCommands>({ dissolveFriendshipOnBlock }),
    );
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    expect(events.emit.mock.calls.some(([topic]) => topic === 'social.friendship.removed')).toBe(
      false,
    );
  });

  it('rolls back the block insert when the social port fails, instead of leaving a block with no dissolve', async () => {
    const dissolveFriendshipOnBlock = vi.fn(async () => {
      throw new Error('boom');
    });
    const { svc } = makeService(undefined, mock<SocialCommands>({ dissolveFriendshipOnBlock }));
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await expect(svc.blockUser(blockerId, blockedId)).rejects.toThrow('boom');

    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(0);
  });

  it('emits only on the first block of a pair', async () => {
    const { svc, events } = makeService();
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);
    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(1);
    expect(events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.blocked')).toHaveLength(
      1,
    );
  });

  it('emits on unblock only when a row was actually removed', async () => {
    const { svc, events } = makeService();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(blockerId, blockedId);

    await svc.unblockUser(blockerId, blockedId, NO_CLIENT_META);
    await svc.unblockUser(blockerId, blockedId, NO_CLIENT_META);

    // Soft-delete: the row survives with removedAt set, not physically removed.
    const rows = await db.drizzle.db.select().from(chatUserBlock);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.removedAt).not.toBeNull();
    expect(
      events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.unblocked'),
    ).toHaveLength(1);
  });

  it('re-blocking after an unblock inserts a fresh active row and re-excludes the sender', async () => {
    const { svc, events } = makeService();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(blockerId, blockedId);
    await svc.unblockUser(blockerId, blockedId, NO_CLIENT_META);

    await svc.blockUser(blockerId, blockedId);

    const rows = await db.drizzle.db.select().from(chatUserBlock);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.removedAt === null)).toHaveLength(1);
    expect(events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.blocked')).toHaveLength(
      2,
    );
    expect(await svc.getExcludedUserIds(blockerId)).toContain(blockedId);
  });

  it('lists the blocked ids newest-first', async () => {
    const { svc } = makeService();
    const blockerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId, blockedId: first, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { blockerId, blockedId: second, createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    const { items } = await svc.listBlockedUsers({
      blockerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items.map((r) => r.blockedId)).toEqual([second, first]);
  });

  it('enriches each entry with the blocked users username, and falls back to null when unresolvable', async () => {
    const blockedId = randomUUID();
    const unresolvableId = randomUUID();
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: async (userIds: readonly string[]) =>
        userIds
          .filter((id) => id === blockedId)
          .map(
            (userId): AdminPlayerSummary => ({
              playerId: randomUUID(),
              userId,
              username: 'BlockedPlayer',
              email: 'blocked@test.dev',
              kycStatus: null,
              language: null,
              avatarUrl: null,
              createdAt: new Date(),
              level: 1,
              currency: 'USD',
            }),
          ),
    });
    const { svc } = makeService(directory);
    const blockerId = randomUUID();
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId, blockedId, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { blockerId, blockedId: unresolvableId, createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);

    const { items } = await svc.listBlockedUsers({
      blockerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items.find((r) => r.blockedId === blockedId)?.username).toBe('BlockedPlayer');
    expect(items.find((r) => r.blockedId === unresolvableId)?.username).toBeNull();
  });

  it('paginates and sorts oldest-first when asked, reporting the total across all pages', async () => {
    const { svc } = makeService();
    const blockerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId, blockedId: first, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { blockerId, blockedId: second, createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { blockerId, blockedId: third, createdAt: new Date('2026-03-01T00:00:00.000Z') },
    ]);

    const page1 = await svc.listBlockedUsers({
      blockerId,
      page: 1,
      limit: 2,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });
    const page2 = await svc.listBlockedUsers({
      blockerId,
      page: 2,
      limit: 2,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });

    expect(page1.items.map((r) => r.blockedId)).toEqual([first, second]);
    expect(page1.total).toBe(3);
    expect(page2.items.map((r) => r.blockedId)).toEqual([third]);
    expect(page2.total).toBe(3);
  });

  it('excludes an unblocked user from the list', async () => {
    const { svc } = makeService();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(blockerId, blockedId);
    await svc.unblockUser(blockerId, blockedId);

    const { items, total } = await svc.listBlockedUsers({
      blockerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe('ChatService.adminListBlockedUsers (real PG, site-wide)', () => {
  it('lists every users blocks, not just one callers, including who blocked whom', async () => {
    const { svc } = makeService();
    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedA = randomUUID();
    const blockedB = randomUUID();
    await svc.blockUser(blockerA, blockedA);
    await svc.blockUser(blockerB, blockedB);

    const { items, total } = await svc.adminListBlockedUsers({
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(total).toBe(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockerId: blockerA, blockedId: blockedA }),
        expect.objectContaining({ blockerId: blockerB, blockedId: blockedB }),
      ]),
    );
  });

  it('excludes an unblocked (soft-removed) relationship', async () => {
    const { svc } = makeService();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await svc.blockUser(blockerId, blockedId);
    await svc.unblockUser(blockerId, blockedId);

    const { items, total } = await svc.adminListBlockedUsers({
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe('ChatService ignore list (real PG)', () => {
  it('rejects ignoring yourself', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    await expect(svc.ignoreUser(userId, userId)).rejects.toThrow(ChatSelfIgnoreError);
  });

  it('emits only on the first ignore of a pair', async () => {
    const { svc, events } = makeService();
    const ignorerId = randomUUID();
    const ignoredId = randomUUID();

    await svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META);
    await svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META);

    expect(await db.drizzle.db.select().from(chatUserIgnore)).toHaveLength(1);
    expect(events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.ignored')).toHaveLength(
      1,
    );
  });

  it('emits on unignore only when a row was actually removed', async () => {
    const { svc, events } = makeService();
    const ignorerId = randomUUID();
    const ignoredId = randomUUID();
    await svc.ignoreUser(ignorerId, ignoredId);

    await svc.unignoreUser(ignorerId, ignoredId, NO_CLIENT_META);
    await svc.unignoreUser(ignorerId, ignoredId, NO_CLIENT_META);

    // Soft-delete: the row survives with removedAt set, not physically removed.
    const rows = await db.drizzle.db.select().from(chatUserIgnore);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.removedAt).not.toBeNull();
    expect(
      events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.unignored'),
    ).toHaveLength(1);
  });

  it('lists the ignored ids newest-first', async () => {
    const { svc } = makeService();
    const ignorerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await db.drizzle.db.insert(chatUserIgnore).values([
      { ignorerId, ignoredId: first, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { ignorerId, ignoredId: second, createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    const { items } = await svc.listIgnoredUsers({
      ignorerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items.map((r) => r.ignoredId)).toEqual([second, first]);
  });

  it('enriches each entry with the ignored users username, and falls back to null when unresolvable', async () => {
    const ignoredId = randomUUID();
    const unresolvableId = randomUUID();
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: async (userIds: readonly string[]) =>
        userIds
          .filter((id) => id === ignoredId)
          .map(
            (userId): AdminPlayerSummary => ({
              playerId: randomUUID(),
              userId,
              username: 'IgnoredPlayer',
              email: 'ignored@test.dev',
              kycStatus: null,
              language: null,
              avatarUrl: null,
              createdAt: new Date(),
              level: 1,
              currency: 'USD',
            }),
          ),
    });
    const { svc } = makeService(directory);
    const ignorerId = randomUUID();
    await db.drizzle.db.insert(chatUserIgnore).values([
      { ignorerId, ignoredId, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { ignorerId, ignoredId: unresolvableId, createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);

    const { items } = await svc.listIgnoredUsers({
      ignorerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items.find((r) => r.ignoredId === ignoredId)?.username).toBe('IgnoredPlayer');
    expect(items.find((r) => r.ignoredId === unresolvableId)?.username).toBeNull();
  });

  it('paginates and sorts oldest-first when asked, reporting the total across all pages', async () => {
    const { svc } = makeService();
    const ignorerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await db.drizzle.db.insert(chatUserIgnore).values([
      { ignorerId, ignoredId: first, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { ignorerId, ignoredId: second, createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { ignorerId, ignoredId: third, createdAt: new Date('2026-03-01T00:00:00.000Z') },
    ]);

    const page1 = await svc.listIgnoredUsers({
      ignorerId,
      page: 1,
      limit: 2,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });
    const page2 = await svc.listIgnoredUsers({
      ignorerId,
      page: 2,
      limit: 2,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });

    expect(page1.items.map((r) => r.ignoredId)).toEqual([first, second]);
    expect(page1.total).toBe(3);
    expect(page2.items.map((r) => r.ignoredId)).toEqual([third]);
    expect(page2.total).toBe(3);
  });

  it('excludes an unignored user from the list', async () => {
    const { svc } = makeService();
    const ignorerId = randomUUID();
    const ignoredId = randomUUID();
    await svc.ignoreUser(ignorerId, ignoredId);
    await svc.unignoreUser(ignorerId, ignoredId);

    const { items, total } = await svc.listIgnoredUsers({
      ignorerId,
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('a block and an ignore are independent relationships (blocking does not ignore, and vice versa)', async () => {
    const { svc } = makeService();
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    const ignoredId = randomUUID();
    await svc.blockUser(viewerId, blockedId);
    await svc.ignoreUser(viewerId, ignoredId);

    const defaultPage = {
      page: 1,
      limit: 100,
      sortBy: 'createdAt' as const,
      sortOrder: 'desc' as const,
    };
    expect(
      (await svc.listBlockedUsers({ blockerId: viewerId, ...defaultPage })).items.map(
        (r) => r.blockedId,
      ),
    ).toEqual([blockedId]);
    expect(
      (await svc.listIgnoredUsers({ ignorerId: viewerId, ...defaultPage })).items.map(
        (r) => r.ignoredId,
      ),
    ).toEqual([ignoredId]);
  });
});

describe('ChatService.adminListIgnoredUsers (real PG, site-wide)', () => {
  it('lists every users ignores, not just one callers, including who ignored whom', async () => {
    const { svc } = makeService();
    const ignorerA = randomUUID();
    const ignorerB = randomUUID();
    const ignoredA = randomUUID();
    const ignoredB = randomUUID();
    await svc.ignoreUser(ignorerA, ignoredA);
    await svc.ignoreUser(ignorerB, ignoredB);

    const { items, total } = await svc.adminListIgnoredUsers({
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(total).toBe(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ignorerId: ignorerA, ignoredId: ignoredA }),
        expect.objectContaining({ ignorerId: ignorerB, ignoredId: ignoredB }),
      ]),
    );
  });

  it('excludes an unignored (soft-removed) relationship', async () => {
    const { svc } = makeService();
    const ignorerId = randomUUID();
    const ignoredId = randomUUID();
    await svc.ignoreUser(ignorerId, ignoredId);
    await svc.unignoreUser(ignorerId, ignoredId);

    const { items, total } = await svc.adminListIgnoredUsers({
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe('ChatService admin rooms (real PG)', () => {
  it('creates a room and returns the serialized row', async () => {
    const { svc, events } = makeService();

    const room = await svc.createRoom({
      name: 'Wheel Spin',
      slug: 'wheel-spin',
      category: 'games-sports',
      ...NO_CLIENT_META,
    });

    expect(room).toMatchObject({ slug: 'wheel-spin', isPublic: true });
    expect(typeof room.createdAt).toBe('string');
    const [configuration] = await db.drizzle.db
      .select()
      .from(chatRoomConfiguration)
      .where(eq(chatRoomConfiguration.roomId, room.id));
    expect(configuration).toMatchObject({ roomId: room.id });
    expect(events.emit).toHaveBeenCalledWith(
      'chat.room.created',
      expect.objectContaining({ roomId: room.id, slug: 'wheel-spin' }),
    );
  });

  it('throws ChatRoomSlugConflictError when the slug is taken', async () => {
    const { svc } = makeService();
    await seedRoom({ slug: 'taken' });

    await expect(
      svc.createRoom({
        name: 'Other',
        slug: 'taken',
        category: 'regions',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomSlugConflictError);
  });

  it('pages public rooms for the requested sort', async () => {
    const { svc } = makeService();
    await seedRoom({ name: 'Alpha', slug: 'alpha' });
    await seedRoom({ name: 'Beta', slug: 'beta' });
    await seedRoom({ name: 'Private', slug: 'priv', isPublic: false });

    const result = await svc.listAdminRooms({
      page: 1,
      limit: 1,
      sortBy: 'name',
      sortOrder: 'asc',
    });

    expect(result.total).toBe(2);
    expect(result.items.map((r) => r.name)).toEqual(['Alpha']);
  });

  it('updates a room and emits a before/after event', async () => {
    const { svc, events } = makeService();
    const room = await seedRoom({ name: 'Old', slug: 'old', category: 'games-sports' });
    const actorId = randomUUID();

    const updated = await svc.updateRoom({
      id: room.id,
      name: 'New',
      category: 'regions',
      actorId,
      ...NO_CLIENT_META,
    });

    expect(updated).toMatchObject({ name: 'New', category: 'regions', slug: 'old' });
    expect(events.emit).toHaveBeenCalledWith(
      'chat.room.updated',
      expect.objectContaining({
        roomId: room.id,
        actorId,
        before: expect.objectContaining({ name: 'Old', category: 'games-sports' }),
        after: expect.objectContaining({ name: 'New', category: 'regions' }),
      }),
    );
  });

  it('allows only the private-room creator to update its name', async () => {
    const { svc } = makeService();
    const ownerId = randomUUID();
    const room = await svc.createPrivateRoom({ userId: ownerId, name: 'Old', ...NO_CLIENT_META });

    await expect(
      svc.updatePrivateRoom({ id: room.id, name: 'New', actorId: ownerId, ...NO_CLIENT_META }),
    ).resolves.toMatchObject({ id: room.id, name: 'New' });

    await expect(
      svc.updatePrivateRoom({
        id: room.id,
        name: 'Hijacked',
        actorId: randomUUID(),
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomOwnershipError);
  });

  it('rejects an update that collides with another rooms slug', async () => {
    const { svc } = makeService();
    await seedRoom({ slug: 'taken' });
    const room = await seedRoom({ slug: 'mine' });

    await expect(
      svc.updateRoom({ id: room.id, slug: 'taken', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomSlugConflictError);
  });

  it('soft-deletes the room while keeping its messages', async () => {
    const { svc } = makeService();
    const room = await seedRoom();
    await seedMessage({ roomId: room.id });

    await expect(svc.deleteRoom(room.id, randomUUID(), NO_CLIENT_META)).resolves.toEqual({
      success: true,
    });

    const [stored] = await db.drizzle.db.select().from(chatRoom).where(eq(chatRoom.id, room.id));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(await db.drizzle.db.select().from(chatMessage)).toHaveLength(1);
  });

  it('throws ChatRoomNotFoundError when deleting twice', async () => {
    const { svc } = makeService();
    const room = await seedRoom();
    await svc.deleteRoom(room.id);

    await expect(svc.deleteRoom(room.id)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('ends a private room only for its owner and emits auditable before/after state', async () => {
    const { svc, events } = makeService();
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: ownerId,
      name: 'End me',
      ...NO_CLIENT_META,
    });

    await expect(
      svc.deletePrivateRoom({ roomId: room.id, userId: otherUserId, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomOwnershipError);

    await expect(
      svc.deletePrivateRoom({ roomId: room.id, userId: ownerId, ...NO_CLIENT_META }),
    ).resolves.toEqual({ success: true });
    const [stored] = await db.drizzle.db.select().from(chatRoom).where(eq(chatRoom.id, room.id));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith(
      'chat.private_room.deleted',
      expect.objectContaining({
        roomId: room.id,
        creatorId: ownerId,
        before: { name: 'End me', slug: room.slug, category: 'private-channels' },
        after: { deletedAt: expect.any(String) },
      }),
    );
  });

  it('cuts every member off the room channel once the room is deleted', async () => {
    const { svc, transport } = makeService();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: ownerId,
      name: 'End me',
      ...NO_CLIENT_META,
    });
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    const ownerDeliveries: unknown[] = [];
    const memberDeliveries: unknown[] = [];
    transport.subscribe(chatChannel(room.id), () => ownerDeliveries.push(true), ownerId);
    transport.subscribe(chatChannel(room.id), () => memberDeliveries.push(true), memberId);

    await svc.deletePrivateRoom({ roomId: room.id, userId: ownerId, ...NO_CLIENT_META });

    transport.publish(chatChannel(room.id), { type: 'chat.message.sent' });
    expect(ownerDeliveries).toEqual([]);
    expect(memberDeliveries).toEqual([]);
  });

  it('leaves the room channel intact when the delete is refused', async () => {
    const { svc, transport } = makeService();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: ownerId,
      name: 'Keep me',
      ...NO_CLIENT_META,
    });
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    const memberDeliveries: unknown[] = [];
    transport.subscribe(chatChannel(room.id), () => memberDeliveries.push(true), memberId);

    await expect(
      svc.deletePrivateRoom({ roomId: room.id, userId: memberId, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomOwnershipError);

    transport.publish(chatChannel(room.id), { type: 'chat.message.sent' });
    expect(memberDeliveries).toEqual([true]);
  });
});

describe('ChatService.createPrivateRoom (real PG)', () => {
  it('creates the room, joins the creator as moderator, and issues a join code', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();

    const room = await svc.createPrivateRoom({ userId, name: 'My Room', ...NO_CLIENT_META });

    expect(room).toMatchObject({ isPublic: false, category: 'private-channels' });
    expect(room.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(room.slug.startsWith('private-')).toBe(true);
    expect(room.slug).not.toContain(room.joinCode?.toLowerCase());
    const [member] = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(member).toMatchObject({ userId, role: 'owner' });
    expect(events.emit).toHaveBeenCalledWith(
      'chat.private_room.created',
      expect.objectContaining({ roomId: room.id, creatorId: userId }),
    );
  });

  it('rejects one room past the per-player cap', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    for (let i = 0; i < MAX_PRIVATE_ROOMS_PER_PLAYER; i++) {
      await svc.createPrivateRoom({ userId, name: `Room ${i}`, ...NO_CLIENT_META });
    }

    await expect(
      svc.createPrivateRoom({ userId, name: 'One too many', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomLimitReachedError);
  });

  it('frees a slot once a room is soft-deleted', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const rooms = [];
    for (let i = 0; i < MAX_PRIVATE_ROOMS_PER_PLAYER; i++) {
      rooms.push(await svc.createPrivateRoom({ userId, name: `Room ${i}`, ...NO_CLIENT_META }));
    }
    await svc.deleteRoom(rooms[0]!.id);

    await expect(
      svc.createPrivateRoom({ userId, name: 'Replacement', ...NO_CLIENT_META }),
    ).resolves.toMatchObject({ name: 'Replacement' });
  });

  it('serializes concurrent creates so the cap cannot be overshot', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    for (let i = 0; i < MAX_PRIVATE_ROOMS_PER_PLAYER - 1; i++) {
      await svc.createPrivateRoom({ userId, name: `Room ${i}`, ...NO_CLIENT_META });
    }

    const settled = await Promise.allSettled([
      svc.createPrivateRoom({ userId, name: 'A', ...NO_CLIENT_META }),
      svc.createPrivateRoom({ userId, name: 'B', ...NO_CLIENT_META }),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('ChatService.joinRoom (real PG)', () => {
  it('joins a public room by its room id', async () => {
    const { svc } = makeService();
    const room = await seedRoom({ isPublic: true, joinCode: 'PUB123' });
    const userId = randomUUID();

    await expect(
      svc.joinPublicRoom({ roomId: room.id, userId, ...NO_CLIENT_META }),
    ).resolves.toMatchObject({ id: room.id });

    const members = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(members.map((member) => member.userId)).toContain(userId);
  });

  it('creates a default-disabled configuration for new private rooms', async () => {
    const { svc } = makeService();
    const room = await svc.createPrivateRoom({
      userId: randomUUID(),
      name: 'Configured room',
      ...NO_CLIENT_META,
    });

    const [configuration] = await db.drizzle.db
      .select()
      .from(chatRoomConfiguration)
      .where(eq(chatRoomConfiguration.roomId, room.id));
    expect(configuration).toMatchObject({
      slowMode: false,
      slowModeSeconds: 0,
      readOnlyMode: false,
      onlyInvitedCanJoin: false,
      lockRoom: false,
      moderatorInvite: false,
    });
  });

  it('joins by code and records the membership once', async () => {
    const { svc, events } = makeService();
    const creatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: creatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const joinerId = randomUUID();

    await svc.joinRoom({ userId: joinerId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    await svc.joinRoom({ userId: joinerId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    const members = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(members).toHaveLength(2);
    expect(
      events.emit.mock.calls.filter(([topic]) => topic === 'chat.room.member.joined'),
    ).toHaveLength(1);
  });

  it('throws ChatRoomJoinCodeNotFoundError for an unknown code', async () => {
    const { svc } = makeService();

    await expect(
      svc.joinRoom({ userId: randomUUID(), joinCode: 'ZZZZZZ', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomJoinCodeNotFoundError);
  });

  it('throws ChatRoomBannedError for a banned user', async () => {
    const { svc } = makeService();
    const creatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: creatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const bannedId = randomUUID();
    await db.drizzle.db
      .insert(chatRoomBan)
      .values({ roomId: room.id, userId: bannedId, bannedBy: creatorId });

    await expect(
      svc.joinRoom({ userId: bannedId, joinCode: room.joinCode!, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomBannedError);
  });
});

describe('ChatService.leaveRoom (real PG)', () => {
  it('refuses to let the sole moderator leave', async () => {
    const { svc } = makeService();
    const creatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: creatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });

    await expect(
      svc.leaveRoom({ userId: creatorId, roomId: room.id, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomLastModeratorError);
  });

  it('removes a plain member and emits left', async () => {
    const { svc, events } = makeService();
    const room = await svc.createPrivateRoom({
      userId: randomUUID(),
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const memberId = randomUUID();
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    await svc.leaveRoom({ userId: memberId, roomId: room.id, ...NO_CLIENT_META });

    const members = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(members.map((m) => m.userId)).not.toContain(memberId);
    expect(events.emit).toHaveBeenCalledWith(
      'chat.room.member.left',
      expect.objectContaining({ roomId: room.id, userId: memberId }),
    );
  });
});

describe('ChatService.setMemberRole (real PG)', () => {
  // `signal` is an optional transport capability the first-party in-process fan-out does not
  // implement (it has one payload lane per channel), so the spy stands in for a managed vendor.
  function transportWithSignal() {
    const signal = vi.fn();
    return { transport: Object.assign(new InProcessRealtimeTransport(), { signal }), signal };
  }

  async function roomWithMember(transport?: RealtimeTransport) {
    const { svc, events, audit } = makeService(undefined, undefined, transport);
    const ownerId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: ownerId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const memberId = randomUUID();
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    return { svc, events, audit, room, ownerId, memberId };
  }

  function readMember(roomId: string, userId: string) {
    return db.drizzle.db
      .select({ role: chatRoomMember.role, roleAssignedAt: chatRoomMember.roleAssignedAt })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
      .limit(1)
      .then(([row]) => row!);
  }

  it('lets the owner promote a member, stamping the assignment time', async () => {
    const { svc, events, room, ownerId, memberId } = await roomWithMember();

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });

    const member = await readMember(room.id, memberId);
    expect(member.role).toBe('moderator');
    expect(member.roleAssignedAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith(
      'chat.room.member.role-changed',
      expect.objectContaining({
        roomId: room.id,
        userId: memberId,
        changedBy: ownerId,
        role: 'moderator',
      }),
    );
  });

  it('lets the owner revoke, clearing the assignment time', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });

    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'member',
      ...NO_CLIENT_META,
    });

    expect(await readMember(room.id, memberId)).toMatchObject({
      role: 'member',
      roleAssignedAt: null,
    });
  });

  it('refuses a promotion by a moderator - granting is owner-only', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });
    const otherId = randomUUID();
    await svc.joinRoom({ userId: otherId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    await expect(
      svc.setMemberRole({
        actorId: memberId,
        roomId: room.id,
        userId: otherId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('refuses a promotion by a plain member', async () => {
    const { svc, room, memberId } = await roomWithMember();
    const otherId = randomUUID();
    await svc.joinRoom({ userId: otherId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    await expect(
      svc.setMemberRole({
        actorId: memberId,
        roomId: room.id,
        userId: otherId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('refuses a non-member actor', async () => {
    const { svc, room, memberId } = await roomWithMember();

    await expect(
      svc.setMemberRole({
        actorId: randomUUID(),
        roomId: room.id,
        userId: memberId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotMemberError);
  });

  it('refuses a target that is not a member of the room', async () => {
    const { svc, room, ownerId } = await roomWithMember();

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: randomUUID(),
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotMemberError);
  });

  it('refuses an owner targeting themselves', async () => {
    const { svc, room, ownerId } = await roomWithMember();

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: ownerId,
        role: 'member',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomSelfModerationError);
  });

  it('refuses a target that is an owner', async () => {
    const { svc, room, ownerId } = await roomWithMember();
    const coOwnerId = randomUUID();
    await db.drizzle.db
      .insert(chatRoomMember)
      .values({ roomId: room.id, userId: coOwnerId, role: 'owner' });

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: coOwnerId,
        role: 'member',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('refuses a soft-deleted room', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();
    await db.drizzle.db
      .update(chatRoom)
      .set({ deletedAt: new Date() })
      .where(eq(chatRoom.id, room.id));

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('is idempotent on a repeated promote and a repeated revoke', async () => {
    const { svc, events, room, ownerId, memberId } = await roomWithMember();
    const roleChanges = () =>
      events.emit.mock.calls.filter(([topic]) => topic === 'chat.room.member.role-changed').length;

    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });
    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
    expect(await readMember(room.id, memberId)).toMatchObject({ role: 'moderator' });
    expect(roleChanges()).toBe(1);

    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'member',
      ...NO_CLIENT_META,
    });
    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'member',
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
    expect(await readMember(room.id, memberId)).toMatchObject({
      role: 'member',
      roleAssignedAt: null,
    });
    expect(roleChanges()).toBe(2);
  });

  it('allows revoking the only moderator - zero moderators is a valid end state', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'member',
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
  });

  it('gives a promoted moderator power over plain members only', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });
    const plainId = randomUUID();
    const peerId = randomUUID();
    await svc.joinRoom({ userId: plainId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    await svc.joinRoom({ userId: peerId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: peerId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });

    await expect(
      svc.muteRoomMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: plainId,
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      svc.removeMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: plainId,
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      svc.removeMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: peerId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
    await expect(
      svc.removeMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: ownerId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('signals the room channel on both promotion and revoke', async () => {
    const { transport, signal } = transportWithSignal();
    const { svc, room, ownerId, memberId } = await roomWithMember(transport);

    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'moderator',
      ...NO_CLIENT_META,
    });
    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'member',
      ...NO_CLIENT_META,
    });

    expect(signal.mock.calls).toEqual([
      [
        chatChannel(room.id),
        CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
        { roomId: room.id, userId: memberId, role: 'moderator' },
      ],
      [
        chatChannel(room.id),
        CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
        { roomId: room.id, userId: memberId, role: 'member' },
      ],
    ]);
  });

  it('stays silent when the member already holds the requested role', async () => {
    const { transport, signal } = transportWithSignal();
    const { svc, room, ownerId, memberId } = await roomWithMember(transport);

    await svc.setMemberRole({
      actorId: ownerId,
      roomId: room.id,
      userId: memberId,
      role: 'member',
      ...NO_CLIENT_META,
    });

    expect(signal).not.toHaveBeenCalled();
  });

  it('stays silent when a non-owner is refused the change', async () => {
    const { transport, signal } = transportWithSignal();
    const { svc, room, memberId } = await roomWithMember(transport);
    const otherId = randomUUID();
    await svc.joinRoom({ userId: otherId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    await expect(
      svc.setMemberRole({
        actorId: memberId,
        roomId: room.id,
        userId: otherId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);

    expect(signal).not.toHaveBeenCalled();
  });

  it('succeeds on a transport that does not implement the signal capability', async () => {
    const { svc, room, ownerId, memberId } = await roomWithMember();

    await expect(
      svc.setMemberRole({
        actorId: ownerId,
        roomId: room.id,
        userId: memberId,
        role: 'moderator',
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
  });
});

describe('ChatService moderation (real PG)', () => {
  async function roomWithMember() {
    const { svc, events, audit, moderation, transport } = makeService();
    const moderatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: moderatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const memberId = randomUUID();
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    return { svc, events, room, moderatorId, memberId, audit, moderation, transport };
  }

  it('kicks a member, who can then rejoin with the code', async () => {
    const { svc, room, moderatorId, memberId, transport } = await roomWithMember();
    const received: unknown[] = [];
    transport.subscribe(chatChannel(room.id), () => received.push(true), memberId);

    await svc.removeMember({ moderatorId, roomId: room.id, userId: memberId, ...NO_CLIENT_META });

    const afterKick = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(afterKick.map((m) => m.userId)).not.toContain(memberId);
    transport.publish(chatChannel(room.id), { type: 'chat.message.sent' });
    expect(received).toEqual([]);
    await expect(
      svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META }),
    ).resolves.toMatchObject({ id: room.id });
  });

  it('bans a member, removing membership and blocking a rejoin', async () => {
    const { svc, room, moderatorId, memberId } = await roomWithMember();

    await svc.banMember({ moderatorId, roomId: room.id, userId: memberId, ...NO_CLIENT_META });

    expect(
      await db.drizzle.db.select().from(chatRoomBan).where(eq(chatRoomBan.roomId, room.id)),
    ).toHaveLength(1);
    await expect(
      svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomBannedError);
  });

  it('is idempotent on a repeated ban', async () => {
    const { svc, room, moderatorId, memberId } = await roomWithMember();

    await svc.banMember({ moderatorId, roomId: room.id, userId: memberId, ...NO_CLIENT_META });
    await svc.banMember({ moderatorId, roomId: room.id, userId: memberId, ...NO_CLIENT_META });

    expect(
      await db.drizzle.db.select().from(chatRoomBan).where(eq(chatRoomBan.roomId, room.id)),
    ).toHaveLength(1);
  });

  it('refuses moderation by a plain member', async () => {
    const { svc, room, memberId } = await roomWithMember();
    const otherId = randomUUID();
    await svc.joinRoom({ userId: otherId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    await expect(
      svc.removeMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: otherId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('allows an owner to moderate like a moderator', async () => {
    const { svc, room, memberId } = await roomWithMember();
    const ownerId = randomUUID();
    await db.drizzle.db
      .insert(chatRoomMember)
      .values({ roomId: room.id, userId: ownerId, role: 'owner' });

    await expect(
      svc.removeMember({
        moderatorId: ownerId,
        roomId: room.id,
        userId: memberId,
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
  });

  it('prevents a moderator from removing another moderator or the owner', async () => {
    const { svc, room, moderatorId, memberId } = await roomWithMember();
    const otherModeratorId = randomUUID();
    await db.drizzle.db.insert(chatRoomMember).values({
      roomId: room.id,
      userId: otherModeratorId,
      role: 'moderator',
    });

    await expect(
      svc.removeMember({
        moderatorId: otherModeratorId,
        roomId: room.id,
        userId: moderatorId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
    await expect(
      svc.removeMember({
        moderatorId: otherModeratorId,
        roomId: room.id,
        userId: memberId,
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });
  });

  it('refuses moderation by a non-member', async () => {
    const { svc, room, memberId } = await roomWithMember();

    await expect(
      svc.removeMember({
        moderatorId: randomUUID(),
        roomId: room.id,
        userId: memberId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotMemberError);
  });

  it('refuses self-moderation', async () => {
    const { svc, room, moderatorId } = await roomWithMember();

    await expect(
      svc.removeMember({
        moderatorId,
        roomId: room.id,
        userId: moderatorId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomSelfModerationError);
    await expect(
      svc.banMember({
        moderatorId,
        roomId: room.id,
        userId: moderatorId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomSelfModerationError);
  });

  it('allows muted users to read but rejects sends for the configured channel', async () => {
    const { svc, audit, moderation } = makeService();
    const room = await seedRoom();
    const userId = randomUUID();
    await moderation.mute({
      userId,
      roomId: room.id,
      durationSeconds: 60,
      reason: 'spam',
      actorId: randomUUID(),
      ...NO_CLIENT_META,
    });

    await expect(svc.getRoomMessages({ roomId: room.id, viewerId: userId })).resolves.toEqual([]);
    await expect(
      svc.sendRoomMessage({ userId, username: 'Muted', roomId: room.id, content: 'hello' }),
    ).rejects.toBeInstanceOf(ChatPlayerMutedError);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chat.mute.created', resourceType: 'chat_mute' }),
    );
  });

  it('enforces global read-only mode on global sends', async () => {
    const { svc } = makeService();
    const globalRoom = await seedRoom({ slug: '__global' });
    await db.drizzle.db.insert(chatRoomConfiguration).values({
      roomId: globalRoom.id,
      readOnlyMode: true,
    });

    await expect(svc.sendGlobalMessage(randomUUID(), 'ReadOnly', 'hello')).rejects.toBeInstanceOf(
      ChatPlayerMutedError,
    );
  });

  it.each(['__all_public', '__all'] as const)(
    'enforces %s mutes on global sends',
    async (scope) => {
      const { svc, moderation } = makeService();
      await moderation.mute({
        userId: randomUUID(),
        roomId: scope,
        durationSeconds: 60,
        reason: 'spam',
        actorId: randomUUID(),
        ...NO_CLIENT_META,
      });
      const [mute] = await db.drizzle.db.select().from(chatMute).limit(1);

      await expect(svc.sendGlobalMessage(mute.userId, 'Muted', 'hello')).rejects.toBeInstanceOf(
        ChatPlayerMutedError,
      );
    },
  );

  it('supports a global mute when the virtual global room has no row', async () => {
    const { svc, moderation } = makeService();
    const userId = randomUUID();

    await expect(
      moderation.mute({
        userId,
        roomId: '__global',
        durationSeconds: 60,
        reason: 'spam',
        actorId: randomUUID(),
        ...NO_CLIENT_META,
      }),
    ).resolves.toEqual({ success: true });

    await expect(svc.sendGlobalMessage(userId, 'Muted', 'hello')).rejects.toBeInstanceOf(
      ChatPlayerMutedError,
    );
  });

  it('enforces an all-chat mute in private rooms', async () => {
    const { svc, moderation } = makeService();
    const { room } = await roomWithMember();
    const userId = randomUUID();
    await svc.joinRoom({ userId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    await moderation.mute({
      userId,
      roomId: '__all',
      durationSeconds: 60,
      reason: 'spam',
      actorId: randomUUID(),
      ...NO_CLIENT_META,
    });

    await expect(
      svc.sendRoomMessage({ userId, username: 'Muted', roomId: room.id, content: 'hello' }),
    ).rejects.toBeInstanceOf(ChatPlayerMutedError);
  });

  it('replaces an expired private-room mute instead of reusing it', async () => {
    const { svc, room, moderatorId, memberId } = await roomWithMember();
    await db.drizzle.db.insert(chatRoomMute).values({
      roomId: room.id,
      userId: memberId,
      mutedBy: moderatorId,
      reason: 'old reason',
      expiresAt: new Date(Date.now() - 1000),
    });

    await svc.muteRoomMember({
      roomId: room.id,
      userId: memberId,
      moderatorId,
      durationSeconds: 60,
      reason: 'new reason',
    });

    const rows = await db.drizzle.db
      .select()
      .from(chatRoomMute)
      .where(eq(chatRoomMute.roomId, room.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.liftedAt)).toHaveLength(1);
    expect(rows.filter((row) => !row.liftedAt)).toHaveLength(1);
  });

  it('enforces a reversible platform ban only on public chat', async () => {
    const { svc, room, memberId, moderation } = await roomWithMember();
    const userId = memberId;
    await moderation.ban({
      userId,
      roomId: '__all_public',
      durationSeconds: null,
      reason: 'abuse',
      actorId: randomUUID(),
      ...NO_CLIENT_META,
    });

    await expect(svc.sendGlobalMessage(userId, 'Banned', 'hello')).rejects.toBeInstanceOf(
      ChatPlayerBannedError,
    );
    await expect(
      svc.sendRoomMessage({ userId, username: 'Banned', roomId: room.id, content: 'hello' }),
    ).resolves.toMatchObject({ userId });

    await moderation.unban({
      userId,
      roomId: '__all_public',
      actorId: randomUUID(),
      ...NO_CLIENT_META,
    });
    await expect(svc.sendGlobalMessage(userId, 'Banned', 'hello')).resolves.toMatchObject({
      userId,
    });
  });

  it('replaces expired admin bans and rejects private-room targets', async () => {
    const { svc, moderation } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    const room = await seedRoom();
    await db.drizzle.db.insert(chatPlatformBan).values({
      userId,
      bannedBy: actorId,
      scope: 'room',
      roomId: room.id,
      reason: 'old reason',
      expiresAt: new Date(Date.now() - 1000),
    });

    await moderation.ban({
      userId,
      roomId: room.id,
      durationSeconds: 60,
      reason: 'new reason',
      actorId,
      ...NO_CLIENT_META,
    });
    const active = await db.drizzle.db
      .select()
      .from(chatPlatformBan)
      .where(and(eq(chatPlatformBan.userId, userId), isNull(chatPlatformBan.liftedAt)));
    expect(active).toHaveLength(1);

    const privateRoom = await svc.createPrivateRoom({
      userId: actorId,
      name: 'Private',
      ...NO_CLIENT_META,
    });
    await expect(
      moderation.ban({
        userId,
        roomId: privateRoom.id,
        durationSeconds: null,
        reason: 'private target',
        actorId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatAdminPrivateRoomModerationError);
  });

  it('admin deletion publishes a tombstone and records audit data', async () => {
    const { svc, audit, moderation } = makeService();
    const message = await seedMessage({ content: 'bad content' });
    const received: ChatMessage[] = [];
    svc.subscribeMessages(null, (event) => received.push(event));

    await moderation.deleteMessage(message.id, randomUUID(), NO_CLIENT_META);

    expect(received[0]).toMatchObject({ id: message.id, isDeleted: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chat.message.deleted', resourceId: message.id }),
    );
    await expect(svc.getGlobalMessages()).resolves.toEqual([]);
  });
});

describe('ChatService.verifyRoomAccess and listings (real PG)', () => {
  it('returns a public room without checking membership', async () => {
    const { svc } = makeService();
    const room = await seedRoom();

    await expect(svc.verifyRoomAccess(room.id)).resolves.toMatchObject({ id: room.id });
  });

  it('throws ChatRoomNotFoundError for an unknown or deleted room', async () => {
    const { svc } = makeService();
    const room = await seedRoom();
    await svc.deleteRoom(room.id);

    await expect(svc.verifyRoomAccess(randomUUID())).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    await expect(svc.verifyRoomAccess(room.id)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('requires membership for a private room', async () => {
    const { svc } = makeService();
    const room = await seedRoom({ isPublic: false, category: 'private-channels' });

    await expect(svc.verifyRoomAccess(room.id)).rejects.toBeInstanceOf(ChatRoomNotMemberError);
    await expect(svc.verifyRoomAccess(room.id, randomUUID())).rejects.toBeInstanceOf(
      ChatRoomNotMemberError,
    );
  });

  it('allows a member into a private room', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const room = await svc.createPrivateRoom({ userId, name: 'Room', ...NO_CLIENT_META });

    await expect(svc.verifyRoomAccess(room.id, userId)).resolves.toMatchObject({ id: room.id });
  });

  it('lists public rooms plus the private rooms the viewer belongs to', async () => {
    const { svc } = makeService();
    const publicRoom = await seedRoom({ slug: 'public-room' });
    await seedRoom({ slug: 'other-private', isPublic: false, category: 'private-channels' });
    const userId = randomUUID();
    const mine = await svc.createPrivateRoom({ userId, name: 'Mine', ...NO_CLIENT_META });

    const anonymous = await svc.listRooms();
    const viewer = await svc.listRooms(userId);

    expect(anonymous.map((r) => r.id)).toEqual([publicRoom.id]);
    expect(viewer.map((r) => r.id).sort()).toEqual([publicRoom.id, mine.id].sort());
  });

  it('lists room members oldest-first, resolving usernames via the directory', async () => {
    const moderatorId = randomUUID();
    const memberId = randomUUID();
    const now = new Date();
    function summary(userId: string, username: string): AdminPlayerSummary {
      return {
        playerId: randomUUID(),
        userId,
        username,
        email: `${username}@example.test`,
        kycStatus: null,
        language: null,
        avatarUrl: null,
        createdAt: now,
        level: 1,
        currency: 'USD',
      };
    }
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: async (ids: readonly string[]) =>
        [summary(moderatorId, 'Moderator'), summary(memberId, 'SilentMember')].filter((s) =>
          ids.includes(s.userId),
        ),
    });
    const { svc } = makeService(directory);
    const room = await svc.createPrivateRoom({
      userId: moderatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    // memberId joins via invite code and never sends a message - the exact repro:
    // a never-posted member must still resolve a real username, not their raw id.
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    const members = await svc.listRoomMembers({ roomId: room.id, viewerId: moderatorId });

    expect(members.map((m) => ({ userId: m.userId, username: m.username }))).toEqual([
      { userId: moderatorId, username: 'Moderator' },
      { userId: memberId, username: 'SilentMember' },
    ]);
    expect(members[0]).toMatchObject({ role: 'owner' });
  });

  it('returns username: null when the directory does not resolve a member', async () => {
    const directory = mock<AdminUserDirectory>({ lookupPlayers: async () => [] });
    const { svc } = makeService(directory);
    const moderatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: moderatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });

    const members = await svc.listRoomMembers({ roomId: room.id, viewerId: moderatorId });

    expect(members).toEqual([expect.objectContaining({ userId: moderatorId, username: null })]);
  });
});

describe('ChatService staff visibility in a room roster (real PG)', () => {
  async function adminOwnedRoom() {
    const { svc } = makeService();
    const admin = await seedUser(db, { name: 'Room Admin', role: 'admin' });
    const player = await seedUser(db, { name: 'Player One', role: 'player' });
    const room = await svc.createPrivateRoom({
      userId: admin.id,
      name: 'Admin room',
      ...NO_CLIENT_META,
    });
    await svc.joinRoom({ userId: player.id, joinCode: room.joinCode!, ...NO_CLIENT_META });
    return { svc, admin, player, room };
  }

  it('shows an admin who owns the room to the players in it', async () => {
    const { svc, admin, player, room } = await adminOwnedRoom();

    const asPlayer = await svc.listRoomMembers({ roomId: room.id, viewerId: player.id });

    expect(asPlayer.map((m) => ({ userId: m.userId, role: m.role }))).toEqual([
      { userId: admin.id, role: 'owner' },
      { userId: player.id, role: 'member' },
    ]);
  });

  it('still hides an admin who is only a member', async () => {
    const { svc, admin, player, room } = await adminOwnedRoom();
    const staffMember = await seedUser(db, { name: 'Support', role: 'super-admin' });
    await svc.joinRoom({ userId: staffMember.id, joinCode: room.joinCode!, ...NO_CLIENT_META });

    const asPlayer = await svc.listRoomMembers({ roomId: room.id, viewerId: player.id });
    const asAdmin = await svc.listRoomMembers({ roomId: room.id, viewerId: admin.id });

    expect(asPlayer.map((m) => m.userId)).toEqual([admin.id, player.id]);
    expect(asAdmin.map((m) => m.userId)).toEqual([admin.id, player.id, staffMember.id]);
  });

  it('shows the owner in the moderator roster too', async () => {
    const { svc, admin, player, room } = await adminOwnedRoom();
    const staffMember = await seedUser(db, { name: 'Support', role: 'admin' });
    await svc.joinRoom({ userId: staffMember.id, joinCode: room.joinCode!, ...NO_CLIENT_META });
    await svc.setMemberRole({
      actorId: admin.id,
      roomId: room.id,
      userId: player.id,
      role: 'moderator',
      ...NO_CLIENT_META,
    });

    const asModerator = await svc.listRoomUsers({
      roomId: room.id,
      actorId: player.id,
      status: 'all',
    });

    expect(asModerator.map((m) => m.userId)).toEqual([admin.id, player.id]);
  });

  it('keeps an owner-only filter free of the staff members it excludes', async () => {
    const { svc, admin, player, room } = await adminOwnedRoom();
    await svc.setMemberRole({
      actorId: admin.id,
      roomId: room.id,
      userId: player.id,
      role: 'moderator',
      ...NO_CLIENT_META,
    });

    const owners = await svc.listRoomUsers({
      roomId: room.id,
      actorId: player.id,
      status: 'owner',
    });

    expect(owners.map((m) => m.userId)).toEqual([admin.id]);
  });
});
