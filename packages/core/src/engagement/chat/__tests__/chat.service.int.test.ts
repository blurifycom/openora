import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { CHAT_ROOM_CATEGORIES, type ChatMessage } from '../contract/index.js';
import { MAX_PRIVATE_ROOMS_PER_PLAYER } from '../contract/constants.js';
import { migrate } from '../migrate.js';
import {
  chatRoom,
  chatMessage,
  chatUserBlock,
  chatRoomMember,
  chatRoomBan,
} from '../schema/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
  ChatRoomLimitReachedError,
  ChatRoomLastModeratorError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from '../service/chat.service.js';

let db: TestDb;

function makeService() {
  const transport = new InProcessRealtimeTransport();
  const events = makeEventBus();
  return { svc: new ChatService(db.drizzle, events, transport), events, transport };
}

async function seedUser(name = 'Player') {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name, email: `${randomUUID()}@test.dev`, emailVerified: true })
    .returning();
  return row!;
}

async function seedRoom(overrides: Partial<typeof chatRoom.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatRoom)
    .values({
      name: 'Jackpot Wheel',
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
  db = await createTestDb([migrate, migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMessage}, ${chatRoomMember}, ${chatRoomBan}, ${chatUserBlock}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
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
});

describe('ChatService.subscribeMessages per-viewer block filtering (real PG)', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: null,
    userId: 'sender',
    username: 'alice',
    content: 'hi',
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
});

describe('ChatService.sendGlobalMessage (real PG)', () => {
  it('stores the display name from the verified user, ignoring the header fallback', async () => {
    const { svc, events } = makeService();
    const account = await seedUser('Platform Admin');

    const msg = await svc.sendGlobalMessage(account.id, 'spoofed-header-name', 'hi');

    expect(msg.username).toBe('Platform Admin');
    const [stored] = await db.drizzle.db.select().from(chatMessage);
    expect(stored).toMatchObject({ roomId: null, username: 'Platform Admin' });
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
});

describe('ChatService.sendRoomMessage (real PG)', () => {
  it('stores and publishes a message in a public room', async () => {
    const { svc, transport } = makeService();
    const room = await seedRoom();
    const account = await seedUser('Alice');
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>(chatChannel(room.id), (m) => delivered.push(m));

    const msg = await svc.sendRoomMessage({
      userId: account.id,
      username: 'ignored',
      roomId: room.id,
      content: 'hello room',
    });

    expect(msg).toMatchObject({ roomId: room.id, username: 'Alice' });
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
  it('soft-deletes the senders own message', async () => {
    const { svc } = makeService();
    const message = await seedMessage();

    await expect(svc.deleteMessage(message.id, message.userId)).resolves.toEqual({ success: true });

    const [stored] = await db.drizzle.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.id, message.id));
    expect(stored?.isDeleted).toBe(true);
  });

  it('throws ChatMessageNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.deleteMessage(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      ChatMessageNotFoundError,
    );
  });

  it('refuses to delete another players message', async () => {
    const { svc } = makeService();
    const message = await seedMessage();

    await expect(svc.deleteMessage(message.id, randomUUID())).rejects.toBeInstanceOf(
      ChatMessageOwnershipError,
    );
  });
});

describe('ChatService block list (real PG)', () => {
  it('rejects blocking yourself', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    await expect(svc.blockUser(userId, userId)).rejects.toThrow(ChatSelfBlockError);
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

    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(0);
    expect(
      events.emit.mock.calls.filter(([topic]) => topic === 'chat.user.unblocked'),
    ).toHaveLength(1);
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

    const rows = await svc.listBlockedUsers(blockerId);

    expect(rows.map((r) => r.blockedId)).toEqual([second, first]);
  });
});

describe('ChatService admin rooms (real PG)', () => {
  it('creates a room and returns the serialized row', async () => {
    const { svc, events } = makeService();

    const room = await svc.createRoom({
      name: 'Jackpot Wheel',
      slug: 'jackpot-wheel',
      category: 'games-sports',
      ...NO_CLIENT_META,
    });

    expect(room).toMatchObject({ slug: 'jackpot-wheel', isPublic: true });
    expect(typeof room.createdAt).toBe('string');
    expect(events.emit).toHaveBeenCalledWith(
      'chat.room.created',
      expect.objectContaining({ roomId: room.id, slug: 'jackpot-wheel' }),
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
    expect(member).toMatchObject({ userId, role: 'moderator' });
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

describe('ChatService moderation (real PG)', () => {
  async function roomWithMember() {
    const { svc, events } = makeService();
    const moderatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: moderatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const memberId = randomUUID();
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });
    return { svc, events, room, moderatorId, memberId };
  }

  it('kicks a member, who can then rejoin with the code', async () => {
    const { svc, room, moderatorId, memberId } = await roomWithMember();

    await svc.kickMember({ moderatorId, roomId: room.id, userId: memberId, ...NO_CLIENT_META });

    const afterKick = await db.drizzle.db
      .select()
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, room.id));
    expect(afterKick.map((m) => m.userId)).not.toContain(memberId);
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
      svc.kickMember({
        moderatorId: memberId,
        roomId: room.id,
        userId: otherId,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('refuses moderation by a non-member', async () => {
    const { svc, room, memberId } = await roomWithMember();

    await expect(
      svc.kickMember({
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
      svc.kickMember({
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

  it('lists room members oldest-first', async () => {
    const { svc } = makeService();
    const moderatorId = randomUUID();
    const room = await svc.createPrivateRoom({
      userId: moderatorId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const memberId = randomUUID();
    await svc.joinRoom({ userId: memberId, joinCode: room.joinCode!, ...NO_CLIENT_META });

    const members = await svc.listRoomMembers({ roomId: room.id, viewerId: moderatorId });

    expect(members.map((m) => m.userId)).toEqual([moderatorId, memberId]);
    expect(members[0]).toMatchObject({ role: 'moderator' });
  });
});
